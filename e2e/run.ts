/**
 * DropQ end-to-end suite.
 *
 *   pnpm e2e                     # local profile: builds if needed, starts the app on 3311,
 *                                # runs every check, stops the server.
 *   pnpm e2e -- --profile prod   # against E2E_BASE_URL: no local DB or process; prod-safe
 *                                # checks only, no live generation.
 *   pnpm e2e:report              # regenerate report.html + summary.json from the last run.
 *   pnpm e2e -- --only K1        # run just the named check(s), skipping the rest.
 *
 * Exit code is non-zero when any check FAILs. SKIPs (quota, no browser, profile) are
 * allowed and always reported with a reason; a check that reports nothing at all is a FAIL.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Browser } from "playwright";
import {
  Budget,
  BudgetAbort,
  E2E_ROOT,
  PresetCacheMissError,
  Recorder,
  launchBrowser,
  startLocalServer,
  writeText,
} from "./lib/harness";
import { buildSummary, writeReportHtml, writeSummary, type Summary } from "./lib/report";
import type { Ctx } from "./lib/ctx";
import { runPresetChecks } from "./checks/presets";
import { runServerChecks } from "./checks/server";
import { runSessionChecks } from "./checks/sessions";
import { runLimitApiChecks, runLimitMessageChecks } from "./checks/limits";
import { runLanguageChecks } from "./checks/language";
import { runLayoutChecks } from "./checks/layout";
import { runDeepCutsChecks } from "./checks/deepcuts";
import { runLiveChecks } from "./checks/live";
import { runA11yChecks } from "./checks/a11y";

const BROWSER_CHECKS: Record<string, string[]> = {
  presets: ["A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "B4", "B5", "B6"],
  messages: ["G2", "G3"],
  language: ["H1", "H2"],
  layout: ["I1", "I2", "I3", "I4", "I5"],
  deepcuts: ["E1", "E2"],
  live: ["C1", "C2", "C3", "D1"],
  a11y: ["K1"],
};

/** Checks that run over plain HTTP, no browser needed. */
const API_CHECKS: Record<string, string[]> = {
  server: ["J1", "J2", "J3"],
  sessions: ["F1", "F2"],
  "limits-api": ["G1", "G4"],
};

/**
 * Every id the suite is expected to record, derived from the lists that drive the
 * run so the two cannot drift apart.
 */
const EXPECTED_IDS: string[] = [
  ...Object.values(API_CHECKS).flat(),
  ...Object.values(BROWSER_CHECKS).flat(),
];

/** A SKIP is only acceptable when it carries one of these reasons. */
const ALLOWED_SKIP_REASONS = new Set(["budget", "no browser", "profile", "quota", "axe-not-installed"]);

/**
 * Cross-check what was recorded against the manifest.
 *
 * A check that quietly reports nothing looks identical to a passing run in the
 * summary, so a missing id is a FAIL here rather than an absence. Every SKIP has
 * to be listed, which is what makes "a SKIP is never a pass" checkable.
 */
function auditCoverage(recorder: Recorder, log: (line: string) => void, expectedIds: string[]): void {
  // Snapshot: recording a FAIL below appends to this array.
  const results = [...recorder.results];
  const seen = new Map<string, number>();
  for (const result of results) {
    seen.set(result.id, (seen.get(result.id) ?? 0) + 1);
  }

  for (const id of expectedIds) {
    const count = seen.get(id) ?? 0;
    if (count === 0) {
      log(`!! ${id} did not report; recording FAIL (unlisted: no result)`);
      recorder.record({
        id,
        name: "coverage",
        profile: recorder.profile,
        cost: "free",
        status: "FAIL",
        ms: 0,
        screenshots: [],
        details: ["unlisted: check produced no result"],
      });
    } else if (count > 1) {
      log(`!! ${id} reported ${count} times; recording FAIL (duplicate)`);
      recorder.record({
        id,
        name: "coverage",
        profile: recorder.profile,
        cost: "free",
        status: "FAIL",
        ms: 0,
        screenshots: [],
        details: [`duplicate: ${count} results for one id`],
      });
    }
  }

  const expected = new Set(EXPECTED_IDS);
  for (const result of results) {
    if (!expected.has(result.id)) {
      log(`!! ${result.id} is not in the manifest; recording FAIL (unlisted id)`);
      recorder.record({
        id: result.id,
        name: "coverage",
        profile: recorder.profile,
        cost: "free",
        status: "FAIL",
        ms: 0,
        screenshots: [],
        details: ["unlisted: id is not in the manifest"],
      });
    }
    if (result.status === "SKIP" && !ALLOWED_SKIP_REASONS.has(result.reason ?? "")) {
      log(`!! ${result.id} skipped with an unlisted reason "${result.reason ?? ""}"`);
      recorder.record({
        id: result.id,
        name: "coverage",
        profile: recorder.profile,
        cost: "free",
        status: "FAIL",
        ms: 0,
        screenshots: [],
        details: [`unlisted skip reason: ${result.reason ?? "(none)"}`],
      });
    }
  }
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : null;
}

async function main(): Promise<void> {
  const logLines: string[] = [];
  const log = (line: string) => {
    logLines.push(line);
    console.log(line);
  };

  if (process.argv.includes("--report")) {
    await regenerateReport();
    return;
  }

  const profile = (argValue("--profile") ?? process.env.E2E_PROFILE ?? "local") as "local" | "prod";
  if (profile !== "local" && profile !== "prod") {
    console.error(`unknown profile "${profile}" (expected local or prod)`);
    process.exitCode = 2;
    return;
  }

  const envBase = process.env.E2E_BASE_URL?.trim();
  if (profile === "prod" && !envBase) {
    console.error("E2E_BASE_URL required for --profile prod (for example E2E_BASE_URL=https://host pnpm e2e -- --profile prod)");
    process.exitCode = 2;
    return;
  }

  // `--only K1` or `--only A1,B1`: run just those checks. Modules are the unit of
  // selection for the browser groups, so selecting one id from a module runs that
  // module's checks; the coverage audit is then scoped to what was asked for.
  const only = (argValue("--only") ?? "")
    .split(",")
    .map((id) => id.trim().toUpperCase())
    .filter(Boolean);
  const selection = only.length > 0 ? new Set(only) : null;
  const selected = (ids: string[]): string[] =>
    selection ? ids.filter((id) => selection.has(id)) : ids;

  const runStart = Date.now();
  let server: { base: string; stop: () => void } | null = null;
  let browser: Browser | null = null;
  const notes: string[] = [];

  if (profile === "local") {
    if (!existsSync(".next")) {
      log("no .next build found; running pnpm build");
      const build = spawnSync("pnpm", ["build"], { stdio: "inherit" });
      if (build.status !== 0) {
        console.error("pnpm build failed");
        process.exitCode = 1;
        return;
      }
    }
    server = await startLocalServer();
  }
  const base = server?.base ?? envBase!;

  try {
    browser = await launchBrowser().catch((error) => {
      notes.push(`no browser: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      return null;
    });

    const recorder = new Recorder(profile, base, log);
    const budget = new Budget();
    const { qlooBuildsSince, disconnect } = await import("./lib/db");
    const ctx: Ctx = {
      profile,
      base,
      browser: browser as Browser,
      budget,
      recorder,
      log,
      qlooBuiltSince: profile === "local" ? qlooBuildsSince : async () => 0,
      refineQlooEstimate: 8,
      runStart,
      llmSkipped: null,
    };

    log(`profile ${profile} · base ${base}`);
    if (notes.length > 0) for (const note of notes) log(`!! ${note}`);
    if (profile === "local") {
      const kept = await warmSignatures();
      const { clearNonWarmCache } = await import("./lib/db");
      const cleared = await clearNonWarmCache(kept).catch(() => 0);
      log(`kept ${kept.length} warmed preset signatures; cleared ${cleared} other cache row(s)`);
    }

    let budgetStopped = false;
    let cacheMiss: string | null = null;
    const guard = async (label: string, ids: string[], run: () => Promise<void>, costly = false): Promise<void> => {
      const wanted = selected(ids);
      if (wanted.length === 0) return;
      if (budgetStopped && costly) {
        for (const id of wanted) skipCheck(recorder, id, label, "budget");
        return;
      }
      if (!browser) {
        for (const id of wanted) skipCheck(recorder, id, label, "no browser");
        return;
      }
      try {
        await run();
      } catch (error) {
        if (error instanceof BudgetAbort) {
          budgetStopped = true;
          log(`!! budget counter aborted the run: ${error.message}`);
          for (const id of wanted) skipCheck(recorder, id, label, "budget");
          return;
        }
        if (error instanceof PresetCacheMissError) {
          // Fatal on purpose: continuing would click through a cold preset and make the
          // deployment run a paid live build. Everything not yet reported becomes a FAIL.
          cacheMiss = error.message;
          log(`!! ABORTED — ${error.message}`);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        log(`!! ${label} threw: ${message}`);
        for (const id of wanted) {
          if (!recorder.results.some((result) => result.id === id)) {
            recorder.record({ id, name: label, profile, cost: "free", status: "FAIL", ms: 0, screenshots: [], details: [`threw: ${message}`] });
          }
        }
      }
    };

    // Cheap API checks first, then the browser flows, then the quota-spending ones.
    // `stop` is set by a fatal abort (a preset that is not in the cache) so the remaining
    // modules are never run: every id they would have reported is failed below instead.
    // Prod: pack loads (A/B/H/I/K) run before G2/G3/G1. G2/G3 used to fire real pack
    // traffic that shared the production per-IP cheap bucket with the suite.
    const stop = () => cacheMiss !== null;
    await guard("server", API_CHECKS.server!, () => runServerChecks(ctx));
    if (!stop()) await guard("sessions", API_CHECKS.sessions!, () => runSessionChecks(ctx));
    if (profile === "local") {
      if (!stop()) await guard("limits-api", API_CHECKS["limits-api"]!, () => runLimitApiChecks(ctx));
      if (!stop()) await guard("limits-messages", BROWSER_CHECKS.messages!, () => runLimitMessageChecks(ctx));
    }
    if (!stop()) await guard("presets", BROWSER_CHECKS.presets!, () => runPresetChecks(ctx));
    // Prod shares one per-IP cheap bucket (60/min). After six preset loads, pause so H/I
    // do not inherit a saturated window from A/B.
    if (!stop() && profile === "prod") {
      log("prod: pausing 65s for the per-IP cheap window before language/layout");
      await new Promise((resolve) => setTimeout(resolve, 65_000));
    }
    if (!stop()) await guard("language", BROWSER_CHECKS.language!, () => runLanguageChecks(ctx));
    if (!stop()) await guard("layout", BROWSER_CHECKS.layout!, () => runLayoutChecks(ctx));
    if (!stop() && profile === "local") {
      await guard("deepcuts", BROWSER_CHECKS.deepcuts!, () => runDeepCutsChecks(ctx), true);
      if (!stop()) await guard("live", BROWSER_CHECKS.live!, () => runLiveChecks(ctx), true);
    } else if (!stop()) {
      for (const id of [...BROWSER_CHECKS.deepcuts!, ...BROWSER_CHECKS.live!]) skipCheck(recorder, id, "quota-spending", "profile");
    }
    if (!stop()) await guard("a11y", BROWSER_CHECKS.a11y!, () => runA11yChecks(ctx));
    if (profile === "prod") {
      if (!stop()) await guard("limits-messages", BROWSER_CHECKS.messages!, () => runLimitMessageChecks(ctx));
      if (!stop()) {
        log("prod: pausing 65s for the per-IP cheap window before G1");
        await new Promise((resolve) => setTimeout(resolve, 65_000));
      }
      if (!stop()) await guard("limits-api", ["G1"], () => runLimitApiChecks(ctx));
      skipCheck(recorder, "G4", "limits-api", "profile");
    }
    if (cacheMiss) {
      const pending = (selection ? EXPECTED_IDS.filter((id) => selection.has(id)) : EXPECTED_IDS).filter(
        (id) => !recorder.results.some((result) => result.id === id),
      );
      log(`!! ${pending.length} check(s) not run: the suite stopped before generating`);
      for (const id of pending) {
        recorder.record({
          id,
          name: "aborted",
          profile,
          cost: "free",
          status: "FAIL",
          ms: 0,
          screenshots: [],
          details: [`not run: aborted on a preset cache miss (${cacheMiss})`],
        });
      }
    }

    if (profile === "local") await disconnect().catch(() => undefined);

    // Nothing may go unreported: a check that never ran, an id outside the
    // manifest, or a SKIP with an unknown reason all become FAILs here.
    auditCoverage(recorder, log, selection ? EXPECTED_IDS.filter((id) => selection.has(id)) : EXPECTED_IDS);

    const summary: Summary = buildSummary({
      profile,
      base,
      startedAt: new Date(runStart).toISOString(),
      finishedAt: new Date().toISOString(),
      ms: Date.now() - runStart,
      budget: {
        gemini: budget.gemini,
        qloo: budget.qloo,
        qlooBuilt: budget.qlooBuilt,
        qlooOther: budget.qlooOther,
        geminiMax: 45,
        qlooMax: 70,
      },
      checks: recorder.results,
    });
    await writeSummary(summary);
    const reportFile = await writeReportHtml(summary);
    await writeText(path.join(E2E_ROOT, "run.log"), `${logLines.join("\n")}\n`);

    const { pass, fail, skip } = summary.totals;
    log("");
    log(`totals: ${pass} PASS, ${fail} FAIL, ${skip} SKIP`);
    log(`budget: ${budget.summary()}`);
    log(`report: ${reportFile}`);
    log(`a SKIP is never a pass.`);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    await browser?.close().catch(() => undefined);
    server?.stop();
  }
}

/** The six warmed preset×locale signatures the run must keep. */
async function warmSignatures(): Promise<string[]> {
  const [{ packSignature }, { PINNED_PRESETS }] = await Promise.all([
    import("../src/lib/pack/cache"),
    import("../src/lib/pipeline/config"),
  ]);
  const keep: string[] = [];
  for (const preset of PINNED_PRESETS) {
    const entityIds = preset.seeds.flatMap((seed) => (seed.entityId ? [seed.entityId] : []));
    for (const locale of ["en", "es"] as const) {
      keep.push(packSignature({ entityIds, city: preset.city, eventKind: preset.eventKind, locale, mode: "default" }));
    }
  }
  return keep;
}

function skipCheck(recorder: Recorder, id: string, name: string, reason: string): void {
  if (recorder.results.some((result) => result.id === id)) return;
  recorder.record({ id, name, profile: recorder.profile, cost: "free", status: "SKIP", reason, ms: 0, screenshots: [], details: [] });
}

async function regenerateReport(): Promise<void> {
  const file = path.join(E2E_ROOT, "summary.json");
  if (!existsSync(file)) {
    console.error("no docs/e2e/summary.json — run `pnpm e2e` first");
    process.exitCode = 2;
    return;
  }
  const { readFile } = await import("node:fs/promises");
  const summary = JSON.parse(await readFile(file, "utf8")) as Summary;
  const reportFile = await writeReportHtml(summary);
  console.log(`report: ${reportFile}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

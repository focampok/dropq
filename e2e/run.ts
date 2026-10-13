/**
 * DropQ end-to-end suite.
 *
 *   pnpm e2e                     # local profile: builds if needed, starts the app on 3311,
 *                                # runs every check, stops the server.
 *   pnpm e2e -- --profile prod   # against E2E_BASE_URL: no local DB or process; prod-safe
 *                                # checks only, no live generation.
 *   pnpm e2e:report              # regenerate report.html + summary.json from the last run.
 *
 * Exit code is non-zero when any check FAILs. SKIPs (quota, no browser, profile) are
 * allowed and always reported with a reason.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Browser } from "playwright";
import { Budget, BudgetAbort, E2E_ROOT, Recorder, launchBrowser, startLocalServer, writeText } from "./lib/harness";
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
  layout: ["I1", "I2", "I3", "I4"],
  deepcuts: ["E1", "E2"],
  live: ["C1", "C2", "C3", "D1"],
  a11y: ["K1"],
};

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
    const guard = async (label: string, ids: string[], run: () => Promise<void>, costly = false): Promise<void> => {
      if (budgetStopped && costly) {
        for (const id of ids) skipCheck(recorder, id, label, "budget");
        return;
      }
      if (!browser) {
        for (const id of ids) skipCheck(recorder, id, label, "no browser");
        return;
      }
      try {
        await run();
      } catch (error) {
        if (error instanceof BudgetAbort) {
          budgetStopped = true;
          log(`!! budget counter aborted the run: ${error.message}`);
          for (const id of ids) skipCheck(recorder, id, label, "budget");
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        log(`!! ${label} threw: ${message}`);
        for (const id of ids) {
          if (!recorder.results.some((result) => result.id === id)) {
            recorder.record({ id, name: label, profile, cost: "free", status: "FAIL", ms: 0, screenshots: [], details: [`threw: ${message}`] });
          }
        }
      }
    };

    // Cheap API checks first, then the browser flows, then the quota-spending ones.
    await guard("server", ["J1", "J2", "J3"], () => runServerChecks(ctx));
    await guard("sessions", ["F1", "F2"], () => runSessionChecks(ctx));
    await guard("limits-api", ["G1", "G4"], () => runLimitApiChecks(ctx));
    if (profile === "prod") skipCheck(recorder, "G4", "limits-api", "profile");
    await guard("limits-messages", BROWSER_CHECKS.messages!, () => runLimitMessageChecks(ctx));
    await guard("presets", BROWSER_CHECKS.presets!, () => runPresetChecks(ctx));
    await guard("language", BROWSER_CHECKS.language!, () => runLanguageChecks(ctx));
    await guard("layout", BROWSER_CHECKS.layout!, () => runLayoutChecks(ctx));
    if (profile === "local") {
      await guard("deepcuts", BROWSER_CHECKS.deepcuts!, () => runDeepCutsChecks(ctx), true);
      await guard("live", BROWSER_CHECKS.live!, () => runLiveChecks(ctx), true);
    } else {
      for (const id of [...BROWSER_CHECKS.deepcuts!, ...BROWSER_CHECKS.live!]) skipCheck(recorder, id, "quota-spending", "profile");
    }
    await guard("a11y", BROWSER_CHECKS.a11y!, () => runA11yChecks(ctx));

    if (profile === "local") await disconnect().catch(() => undefined);

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

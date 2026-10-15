/**
 * Warm pinned presets into PackCache, or `--check` the stored rows (no network).
 * Never replaces an LLM-narrated row with a template one.
 *
 * Builds 3 presets × en/es = 6 rows. A failure or a Gemini budget hit on one row must
 * not abort the remaining rows (that left Spanish missing after an earlier warm), and
 * an LLM outage must not turn a row into `failed`: the pipeline degrades to rule B and
 * the template on its own, so the row is written (or kept) and `reason=` names the
 * cause. This is an operator tool, so the visitor-facing soft caps are lifted while it
 * runs — see `setOperatorBypass`.
 *
 * Everything that decides a row's fate lives in `warm-run.ts`; this file is the CLI:
 * the database target guard, the real dependencies, the flags and the exit code.
 */
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { prisma } from "../src/lib/db";
import { PACK_CACHE_PRESET_TTL_HOURS } from "../src/lib/config";
import { observedQlooCalls, qlooQuota } from "../src/lib/qloo/client";
import { geminiCallCount, resetGeminiCallCount } from "../src/lib/llm/gemini-chain";
import { llmConfigured, llmDisabled } from "../src/lib/llm/provider";
import { geminiDailyExhaustion } from "../src/lib/pipeline/llm";
import { PINNED_PRESETS } from "../src/lib/pipeline/config";
import { runPipeline } from "../src/lib/pipeline/run";
import { setOperatorBypass } from "../src/lib/rate-limit";
import {
  packNarrationGrade,
  packSignature,
  snapshotSessionPacks,
  writePackCacheIfBetter,
  type NarrationGrade,
  type PackCachePayload,
} from "../src/lib/pack/cache";
import { validateCrossLanguageParity, validatePack } from "../src/lib/pack/validate";
import { relocalizeCachedPack } from "../src/lib/pipeline/run";
import {
  LOCALES,
  WARM_MAX_ROUNDS_DEFAULT,
  WARM_MIN_PAUSE_S,
  WARM_PAUSE_S_DEFAULT,
  WarmArgError,
  classifyBuildError,
  numericArg,
  onlySelectors,
  planLlmReport,
  runWarmRounds,
  selectTargets,
  stopLine,
  summaryLine,
  warmRowLine,
  warmTargets,
  type WarmBuild,
  type WarmDeps,
  type WarmLocale,
  type WarmTarget,
} from "./warm-run";

export { LOCALES, warmTargets, warmRowLine, selectTargets };
export type { WarmLocale, WarmTarget };

/** Required to touch a database that is not on this machine. Never implied. */
export const REMOTE_FLAG = "--confirm-remote";

export type DatabaseTarget = "local" | "remote" | "missing";

/**
 * Which database this run would write to, from the `DATABASE_URL` host only.
 *
 * The point is to catch the expensive mistake — warming production while
 * believing you are warming local, or the reverse — so an unparseable URL is
 * reported as remote (the cautious answer).
 */
export function databaseTarget(url = process.env.DATABASE_URL): DatabaseTarget {
  const raw = url?.trim();
  if (!raw) return "missing";
  try {
    // Bracket-stripped: a non-special scheme keeps the IPv6 brackets in hostname.
    const host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1" ? "local" : "remote";
  } catch {
    return "remote";
  }
}

/** A non-local target always needs the explicit flag, on every single run. */
export function requiresRemoteConfirmation(target: DatabaseTarget, argv: string[]): boolean {
  return target === "remote" && !argv.includes(REMOTE_FLAG);
}

/**
 * Announce the target and refuse a remote one unless the operator said so.
 * Prints only the word `local` or `remote`: never the host, the URL or any
 * credential, so the output is safe to paste into a log or an issue.
 */
function guardDatabaseTarget(): void {
  const target = databaseTarget();
  if (target === "missing") {
    console.error("DATABASE_URL is not set; nothing to warm.");
    process.exit(2);
  }
  console.log(`warm database: ${target}`);
  if (requiresRemoteConfirmation(target, process.argv)) {
    console.error(
      `refusing to warm a non-local database without ${REMOTE_FLAG}; re-run with it if this is intended`,
    );
    process.exit(2);
  }
}

/** One row of `--check`: what is stored for a preset × language right now. */
export type WarmCheckRow = {
  presetId: string;
  locale: string;
  /** Whether a PackCache row exists for the current pipeline signature. */
  present: boolean;
  builtAt: string | null;
  ageHours: number | null;
  /** Relative to `PRESET_CACHE_TTL_HOURS`; stale is a warning, not a failure. */
  freshness: "fresh" | "stale" | "n/a";
  /** Overall narration grade for the row (`llm` required for ok). */
  grade: NarrationGrade | "missing";
  narration: { A: NarrationGrade | "missing"; B: NarrationGrade | "missing" };
  modelUsed: { A: string | null; B: string | null };
  /** False only when missing or still on template narration. */
  ok: boolean;
  reason?: "missing" | "template" | "stale";
};

function planNarration(pack: PackCachePayload["packs"][number] | undefined): {
  grade: NarrationGrade | "missing";
  modelUsed: string | null;
} {
  if (!pack) return { grade: "missing", modelUsed: null };
  const llm = planLlmReport(pack);
  return { grade: llm.narrative ?? "template", modelUsed: llm.modelUsed };
}

export function evaluateWarmCheck(input: {
  presetId: string;
  locale: string;
  row: { payload: PackCachePayload; builtAt: Date } | null;
  nowMs?: number;
  ttlHours?: number;
}): WarmCheckRow {
  const ttlHours = input.ttlHours ?? PACK_CACHE_PRESET_TTL_HOURS;
  const now = input.nowMs ?? Date.now();
  if (!input.row) {
    return {
      presetId: input.presetId,
      locale: input.locale,
      present: false,
      builtAt: null,
      ageHours: null,
      freshness: "n/a",
      grade: "missing",
      narration: { A: "missing", B: "missing" },
      modelUsed: { A: null, B: null },
      ok: false,
      reason: "missing",
    };
  }
  const ageHours = (now - input.row.builtAt.getTime()) / 3_600_000;
  const a = planNarration(input.row.payload.packs.find((p) => p.label === "A"));
  const b = planNarration(input.row.payload.packs.find((p) => p.label === "B"));
  const grade = packNarrationGrade(input.row.payload);
  const freshness: WarmCheckRow["freshness"] = ageHours > ttlHours ? "stale" : "fresh";
  let reason: WarmCheckRow["reason"];
  if (grade === "template") reason = "template";
  else if (freshness === "stale") reason = "stale";
  // Missing or template fail the gate; stale-but-present is a warning only.
  const ok = grade !== "template";
  return {
    presetId: input.presetId,
    locale: input.locale,
    present: true,
    builtAt: input.row.builtAt.toISOString(),
    ageHours: Math.round(ageHours * 10) / 10,
    freshness,
    grade,
    narration: { A: a.grade, B: b.grade },
    modelUsed: { A: a.modelUsed, B: b.modelUsed },
    ok,
    reason,
  };
}

function presetById(presetId: WarmTarget["presetId"]): (typeof PINNED_PRESETS)[number] {
  const preset = PINNED_PRESETS.find((row) => row.id === presetId);
  if (!preset) throw new WarmArgError(`unknown preset "${presetId}"`);
  return preset;
}

function signatureFor(target: WarmTarget): string {
  const preset = presetById(target.presetId);
  const entityIds = preset.seeds.map((seed) => seed.entityId!).filter(Boolean);
  return packSignature({
    entityIds,
    city: preset.city,
    eventKind: preset.eventKind,
    locale: target.locale,
    mode: "default",
  });
}

async function checkMode(targets: WarmTarget[], validate: boolean): Promise<number> {
  let failed = 0;
  let violations = 0;
  const byPreset = new Map<string, { en?: PackCachePayload; es?: PackCachePayload }>();
  for (const target of targets) {
    const row = await prisma.packCache.findUnique({ where: { signature: signatureFor(target) } });
    const result = evaluateWarmCheck({
      presetId: target.presetId,
      locale: target.locale,
      row: row
        ? { payload: row.payload as unknown as PackCachePayload, builtAt: row.builtAt }
        : null,
    });
    let invalidRule: string | undefined;
    if (validate && row) {
      const payload = row.payload as unknown as PackCachePayload;
      const check = validatePack(payload);
      if (!check.ok) {
        invalidRule = check.rule;
        violations += 1;
        failed += 1;
      }
      const bucket = byPreset.get(target.presetId) ?? {};
      bucket[target.locale] = payload;
      byPreset.set(target.presetId, bucket);
    }
    if (!result.ok && !invalidRule) failed += 1;
    const status = invalidRule
      ? `fail:invalid`
      : !result.ok
        ? `fail:${result.reason}`
        : result.reason === "stale"
          ? "warn:stale"
          : "ok";
    console.log(
      warmRowLine({
        presetId: result.presetId,
        locale: target.locale,
        status,
        reason: invalidRule ? `invalid:${invalidRule}` : result.reason ?? "ok",
        // `--check` reads stored rows: nothing was attempted in this process.
        attempts: 0,
        narration: result.narration,
        modelUsed: result.modelUsed,
        geminiCalls: 0,
        qlooCalls: 0,
        extra: [
          `present=${result.present}`,
          `age_h=${result.ageHours ?? "n/a"}`,
          `freshness=${result.freshness}`,
          `grade=${result.grade}`,
          result.builtAt ?? "builtAt=n/a",
        ].join(" "),
      }),
    );
  }
  if (validate) {
    for (const [presetId, pair] of byPreset) {
      if (!pair.en || !pair.es) continue;
      const parity = validateCrossLanguageParity(pair.en, pair.es);
      if (!parity.ok) {
        violations += 1;
        failed += 1;
        console.log(
          warmRowLine({
            presetId,
            locale: "en",
            status: "fail:parity",
            reason: `invalid:${parity.rule}`,
            attempts: 0,
            narration: { A: "n/a", B: "n/a" },
            modelUsed: { A: null, B: null },
            geminiCalls: 0,
            qlooCalls: 0,
            extra: `detail=${parity.detail ?? "n/a"}`,
          }),
        );
      }
    }
  }
  console.log(`warm check ${Math.max(0, targets.length - failed)}/${targets.length} ok`);
  if (validate) console.log(`warm validate violations=${violations}`);
  return failed > 0 ? 1 : 0;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** A message safe to print: the Qloo key is never in it, and it stays one line. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "failed";
  const key = process.env.QLOO_API_KEY ?? "";
  return (key ? message.split(key).join("[redacted]") : message).replace(/\s+/g, " ").slice(0, 240);
}

/** One pack build in its own session, exactly as a visitor's first request does it. */
async function buildOnce(target: WarmTarget): Promise<WarmBuild> {
  const preset = presetById(target.presetId);
  const qlooBefore = observedQlooCalls();
  try {
    const other: WarmLocale = target.locale === "en" ? "es" : "en";
    const sibling = await prisma.packCache.findUnique({
      where: { signature: signatureFor({ presetId: target.presetId, locale: other }) },
    });
    const session = await prisma.session.create({
      data: {
        city: preset.city,
        eventKind: preset.eventKind,
        locale: target.locale,
        seeds: {
          create: preset.seeds.map((seed) => ({ rawText: seed.rawText, source: "preset" })),
        },
      },
    });
    // Shared cards: the first language of a preset runs Qloo + anchors; the second only
    // narrates from the sibling row so EN and ES never diverge.
    if (sibling) {
      const snap = await relocalizeCachedPack(
        session.id,
        sibling.payload as unknown as PackCachePayload,
        target.locale,
      );
      return { ok: true, payload: snap, qlooCalls: Math.max(0, observedQlooCalls() - qlooBefore) };
    }
    await runPipeline(session.id, () => undefined);
    const snap = await snapshotSessionPacks(session.id);
    if (!snap) {
      console.log(`${target.presetId}/${target.locale} build_error empty_snapshot`);
      return { ok: false, reason: "build_error" };
    }
    return { ok: true, payload: snap, qlooCalls: Math.max(0, observedQlooCalls() - qlooBefore) };
  } catch (error) {
    console.log(`${target.presetId}/${target.locale} build_error ${safeMessage(error)}`);
    return { ok: false, reason: classifyBuildError(error) };
  }
}

/**
 * The real dependencies: this database, the real pipeline, the process-wide counters.
 * Exported so the integration test can drive the same wiring it runs in production.
 */
export const productionDeps: WarmDeps = {
  now: () => Date.now(),
  sleep,
  build: buildOnce,
  readStored: async (target) => {
    const row = await prisma.packCache.findUnique({ where: { signature: signatureFor(target) } });
    return row ? { grade: packNarrationGrade(row.payload as unknown as PackCachePayload) } : null;
  },
  write: async ({ target, payload, qlooCalls }) => {
    const other: WarmLocale = target.locale === "en" ? "es" : "en";
    const sibling = await prisma.packCache.findUnique({
      where: { signature: signatureFor({ presetId: target.presetId, locale: other }) },
    });
    if (sibling) {
      const parity = validateCrossLanguageParity(
        sibling.payload as unknown as PackCachePayload,
        payload,
      );
      if (!parity.ok) {
        return { wrote: false, grade: packNarrationGrade(payload), invalidRule: parity.rule };
      }
    }
    const result = await writePackCacheIfBetter({
      signature: signatureFor(target),
      payload,
      qlooCalls,
      isPreset: true,
    });
    return { wrote: result.wrote, grade: result.grade, invalidRule: result.invalidRule };
  },
  llm: () => ({ configured: llmConfigured(), disabled: llmDisabled() }),
  geminiCalls: geminiCallCount,
  qlooCalls: observedQlooCalls,
  qlooQuota,
  dailyExhaustion: geminiDailyExhaustion,
  log: (line) => console.log(line),
};

async function main(): Promise<void> {
  // `loadEnvFile` never overrides a variable that is already in the process
  // environment, so `DATABASE_URL=... pnpm warm` targets that database and the
  // `.env` file only fills in what the shell left unset.
  if (existsSync(".env")) loadEnvFile(".env");
  guardDatabaseTarget();
  const argv = process.argv.slice(2);

  let targets: WarmTarget[];
  try {
    targets = selectTargets(onlySelectors(argv));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "bad arguments");
    process.exit(2);
  }

  if (argv.includes("--check")) {
    const code = await checkMode(targets, argv.includes("--validate"));
    await prisma.$disconnect();
    process.exit(code);
  }

  const untilOk = argv.includes("--until-ok");
  let maxRounds = WARM_MAX_ROUNDS_DEFAULT;
  let pauseS = WARM_PAUSE_S_DEFAULT;
  try {
    maxRounds = Math.max(1, numericArg(argv, "--max-rounds", WARM_MAX_ROUNDS_DEFAULT));
    pauseS = Math.max(WARM_MIN_PAUSE_S, numericArg(argv, "--pause-s", WARM_PAUSE_S_DEFAULT));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "bad arguments");
    process.exit(2);
  }

  // Operator tool, not visitor traffic: the hourly soft cap must not turn a six-row
  // rebuild into a six-row template set. The Qloo guard, the Qloo usage counter and
  // `LLM_DISABLED` all still apply.
  setOperatorBypass(true);
  resetGeminiCallCount();
  // The LLM being off is not a reason to skip the rebuild: the pipeline version changed,
  // so every stored row is a miss and the rows still have to be rewritten with template
  // narration. Running the warm again after the daily quota resets upgrades those same
  // rows to LLM narration (an LLM row replaces a template row).
  if (!llmConfigured() || llmDisabled()) {
    console.log("warm llm_off: writing template rows");
  }

  const result = await runWarmRounds(
    targets,
    { untilOk, maxRounds, pauseMs: pauseS * 1000 },
    productionDeps,
  );

  for (const row of result.rows) {
    console.log(warmRowLine({ ...row, extra: `ms=${row.ms}` }));
  }
  const stop = stopLine(result.stop, result.resetMs);
  if (stop) console.log(stop);
  const llmRows = targets.length - (await countPending(targets));
  console.log(
    summaryLine({
      rows: result.rows,
      rounds: result.rounds,
      geminiCalls: geminiCallCount(),
      qlooCalls: observedQlooCalls(),
      targets: targets.length,
      llmRows,
    }),
  );

  await prisma.$disconnect();
  const failed = result.rows.some((row) => row.status === "failed") ? 1 : 0;
  if (result.stop === "all_llm") process.exit(0);
  if (result.stop === "single_round") process.exit(failed);
  process.exit(1);
}

/** Rows still not `llm` in the store, for the summary's `llm_rows=` count. */
async function countPending(targets: WarmTarget[]): Promise<number> {
  let pending = 0;
  for (const target of targets) {
    const row = await prisma.packCache.findUnique({ where: { signature: signatureFor(target) } });
    const grade = row ? packNarrationGrade(row.payload as unknown as PackCachePayload) : "template";
    if (grade !== "llm") pending += 1;
  }
  return pending;
}

const invoked =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("warm-presets.ts") || process.argv[1].endsWith("warm-presets.js"));
if (invoked) void main();

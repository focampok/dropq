/**
 * Warm pinned presets into PackCache, or `--check` the stored rows (no network).
 * Never replaces an LLM-narrated row with a template one.
 *
 * Builds 3 presets × en/es = 6 rows. A failure or gemini budget hit on one row must
 * not abort the remaining rows (that left Spanish missing after the previous warm).
 */
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { prisma } from "../src/lib/db";
import { PACK_CACHE_PRESET_TTL_HOURS, QLOO_CUSTOM_RESERVE } from "../src/lib/config";
import { observedQlooCalls, qlooQuota } from "../src/lib/qloo/client";
import { geminiCallCount, resetGeminiCallCount } from "../src/lib/llm/gemini-chain";
import { llmConfigured, llmDisabled } from "../src/lib/llm/provider";
import { geminiQuotaBlocked } from "../src/lib/pipeline/llm";
import { PINNED_PRESETS } from "../src/lib/pipeline/config";
import { runPipeline } from "../src/lib/pipeline/run";
import {
  detectPresetFromPayload,
  packNarrationGrade,
  packSignature,
  snapshotSessionPacks,
  writePackCacheIfBetter,
  type NarrationGrade,
  type PackCachePayload,
} from "../src/lib/pack/cache";

export const LOCALES = ["en", "es"] as const;
/** Enough for 6 rows × a few chain attempts; do not abort mid-matrix when one row is slow. */
const GEMINI_BUDGET = 48;
const WARM_ATTEMPTS = 3;
const WARM_RETRY_PAUSE_MS = 2_000;
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

export type WarmLocale = (typeof LOCALES)[number];

export type WarmTarget = {
  presetId: (typeof PINNED_PRESETS)[number]["id"];
  locale: WarmLocale;
};

/** Every preset × language the warm command must visit (6 rows). */
export function warmTargets(): WarmTarget[] {
  const out: WarmTarget[] = [];
  for (const preset of PINNED_PRESETS) {
    for (const locale of LOCALES) {
      out.push({ presetId: preset.id, locale });
    }
  }
  return out;
}

export type WarmCheckRow = {
  presetId: string;
  locale: string;
  builtAt: string | null;
  ageHours: number | null;
  narration: { A: NarrationGrade | "missing"; B: NarrationGrade | "missing" };
  modelUsed: { A: string | null; B: string | null };
  ok: boolean;
  reason?: "missing" | "template" | "stale";
};

function planNarration(pack: PackCachePayload["packs"][number] | undefined): {
  grade: NarrationGrade | "missing";
  modelUsed: string | null;
} {
  if (!pack) return { grade: "missing", modelUsed: null };
  const coverage = pack.coverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    return { grade: "template", modelUsed: null };
  }
  const llm = (coverage as { llm?: { narrative?: unknown; modelUsed?: { narrative?: unknown } } }).llm;
  const grade: NarrationGrade = llm?.narrative === "llm" ? "llm" : "template";
  const model =
    typeof llm?.modelUsed?.narrative === "string" ? llm.modelUsed.narrative : null;
  return { grade, modelUsed: model };
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
      builtAt: null,
      ageHours: null,
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
  let reason: WarmCheckRow["reason"];
  if (grade === "template") reason = "template";
  else if (ageHours > ttlHours) reason = "stale";
  const ok = !reason;
  return {
    presetId: input.presetId,
    locale: input.locale,
    builtAt: input.row.builtAt.toISOString(),
    ageHours: Math.round(ageHours * 10) / 10,
    narration: { A: a.grade, B: b.grade },
    modelUsed: { A: a.modelUsed, B: b.modelUsed },
    ok,
    reason,
  };
}

/** One report line for a warmed or checked row (preset, lang, A/B narration, models, calls). */
export function formatWarmRowLine(input: {
  presetId: string;
  locale: string;
  status: string;
  narration: { A: string; B: string };
  modelUsed: { A: string | null; B: string | null };
  geminiCalls: number;
  qlooCalls: number;
  extra?: string;
}): string {
  const parts = [
    input.presetId,
    input.locale,
    input.status,
    `A=${input.narration.A}`,
    `B=${input.narration.B}`,
    `modelA=${input.modelUsed.A ?? "none"}`,
    `modelB=${input.modelUsed.B ?? "none"}`,
    `gemini=${input.geminiCalls}`,
    `qloo=${input.qlooCalls}`,
  ];
  if (input.extra) parts.push(input.extra);
  return parts.join(" ");
}

async function checkMode(): Promise<number> {
  let failed = 0;
  const targets = warmTargets();
  for (const target of targets) {
    const preset = PINNED_PRESETS.find((row) => row.id === target.presetId)!;
    const entityIds = preset.seeds.map((seed) => seed.entityId!).filter(Boolean);
    const signature = packSignature({
      entityIds,
      city: preset.city,
      eventKind: preset.eventKind,
      locale: target.locale,
      mode: "default",
    });
    const row = await prisma.packCache.findUnique({ where: { signature } });
    const result = evaluateWarmCheck({
      presetId: target.presetId,
      locale: target.locale,
      row: row
        ? { payload: row.payload as unknown as PackCachePayload, builtAt: row.builtAt }
        : null,
    });
    if (!result.ok) failed += 1;
    console.log(
      formatWarmRowLine({
        presetId: result.presetId,
        locale: result.locale,
        status: result.ok ? "ok" : `fail:${result.reason}`,
        narration: result.narration,
        modelUsed: result.modelUsed,
        geminiCalls: 0,
        qlooCalls: 0,
        extra:
          result.builtAt == null
            ? "age=n/a"
            : `${result.builtAt} age_h=${result.ageHours}`,
      }),
    );
  }
  console.log(`warm check ${targets.length - failed}/${targets.length} ok`);
  return failed > 0 ? 1 : 0;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildOnce(
  preset: (typeof PINNED_PRESETS)[number],
  locale: WarmLocale,
): Promise<{ payload: PackCachePayload; qlooCalls: number } | null> {
  const qlooBefore = observedQlooCalls();
  const session = await prisma.session.create({
    data: {
      city: preset.city,
      eventKind: preset.eventKind,
      locale,
      seeds: {
        create: preset.seeds.map((seed) => ({ rawText: seed.rawText, source: "preset" })),
      },
    },
  });
  try {
    await runPipeline(session.id, () => undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed";
    const key = process.env.QLOO_API_KEY ?? "";
    const safe = key ? message.split(key).join("[redacted]") : message;
    console.log(`${preset.id}/${locale} build_error ${safe}`);
    return null;
  }
  const snap = await snapshotSessionPacks(session.id);
  if (!snap) {
    console.log(`${preset.id}/${locale} empty`);
    return null;
  }
  return { payload: snap, qlooCalls: Math.max(0, observedQlooCalls() - qlooBefore) };
}

function pickBetter(
  left: { payload: PackCachePayload; qlooCalls: number } | null,
  right: { payload: PackCachePayload; qlooCalls: number },
): { payload: PackCachePayload; qlooCalls: number } {
  if (!left) return right;
  const leftGrade = packNarrationGrade(left.payload);
  const rightGrade = packNarrationGrade(right.payload);
  if (rightGrade === "llm" && leftGrade === "template") return right;
  if (rightGrade === leftGrade) return right;
  return left;
}

export type WarmOneOutcome = "ok" | "needs_rewarm" | "skipped_budget" | "skipped_quota" | "failed";

async function warmOne(
  preset: (typeof PINNED_PRESETS)[number],
  locale: WarmLocale,
): Promise<WarmOneOutcome> {
  const started = Date.now();
  const geminiBefore = geminiCallCount();
  const entityIds = preset.seeds.map((seed) => seed.entityId!).filter(Boolean);
  const signature = packSignature({
    entityIds,
    city: preset.city,
    eventKind: preset.eventKind,
    locale,
    mode: "default",
  });

  const llmOn = llmConfigured() && !llmDisabled();
  const attempts = llmOn ? WARM_ATTEMPTS : 1;
  let best: { payload: PackCachePayload; qlooCalls: number } | null = null;
  let skippedBudget = false;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (geminiCallCount() >= GEMINI_BUDGET) {
      skippedBudget = true;
      break;
    }
    const quota = qlooQuota();
    if (quota.blocked || (quota.remaining !== undefined && quota.remaining < QLOO_CUSTOM_RESERVE)) {
      console.log(
        formatWarmRowLine({
          presetId: preset.id,
          locale,
          status: "skipped_quota_reserve",
          narration: { A: "missing", B: "missing" },
          modelUsed: { A: null, B: null },
          geminiCalls: geminiCallCount() - geminiBefore,
          qlooCalls: 0,
        }),
      );
      return "skipped_quota";
    }
    if (llmOn && geminiQuotaBlocked()) break;

    const built = await buildOnce(preset, locale);
    if (!built) break;
    best = pickBetter(best, built);
    if (packNarrationGrade(best.payload) === "llm") break;
    if (llmOn && geminiQuotaBlocked()) break;
    if (attempt < attempts) await sleep(WARM_RETRY_PAUSE_MS);
  }

  if (!best) {
    console.log(
      formatWarmRowLine({
        presetId: preset.id,
        locale,
        status: skippedBudget ? "skipped_gemini_budget" : "failed",
        narration: { A: "missing", B: "missing" },
        modelUsed: { A: null, B: null },
        geminiCalls: geminiCallCount() - geminiBefore,
        qlooCalls: 0,
        extra: `ms=${Date.now() - started}`,
      }),
    );
    return skippedBudget ? "skipped_budget" : "failed";
  }

  const result = await writePackCacheIfBetter({
    signature,
    payload: best.payload,
    qlooCalls: best.qlooCalls,
    isPreset: true,
  });
  const a = planNarration(best.payload.packs.find((p) => p.label === "A"));
  const b = planNarration(best.payload.packs.find((p) => p.label === "B"));
  const status =
    result.grade === "template"
      ? "needs_rewarm"
      : result.wrote
        ? "cached"
        : "kept";
  console.log(
    formatWarmRowLine({
      presetId: preset.id,
      locale,
      status,
      narration: { A: a.grade, B: b.grade },
      modelUsed: { A: a.modelUsed, B: b.modelUsed },
      geminiCalls: geminiCallCount() - geminiBefore,
      qlooCalls: best.qlooCalls,
      extra: `ms=${Date.now() - started} preset=${detectPresetFromPayload(best.payload)}`,
    }),
  );
  return result.grade === "template" ? "needs_rewarm" : "ok";
}

async function main(): Promise<void> {
  // `loadEnvFile` never overrides a variable that is already in the process
  // environment, so `DATABASE_URL=... pnpm warm` targets that database and the
  // `.env` file only fills in what the shell left unset.
  if (existsSync(".env")) loadEnvFile(".env");
  guardDatabaseTarget();
  const check = process.argv.includes("--check");
  if (check) {
    const code = await checkMode();
    await prisma.$disconnect();
    process.exit(code);
  }

  resetGeminiCallCount();
  // The LLM being off is not a reason to skip the rebuild: the pipeline version changed,
  // so every stored row is a miss and the six rows still have to be rewritten with
  // template narration. `pnpm warm` is run again after the daily Gemini quota resets to
  // upgrade those same rows to LLM narration (an LLM row replaces a template row).
  if (!llmConfigured() || llmDisabled()) {
    console.log("warm llm_off: writing template rows");
  }

  const targets = warmTargets();
  let ok = 0;
  for (const target of targets) {
    const preset = PINNED_PRESETS.find((row) => row.id === target.presetId)!;
    const outcome = await warmOne(preset, target.locale);
    if (outcome === "ok") ok += 1;
    // Continue every remaining preset×locale — never abort the matrix early.
  }
  console.log(
    `warm done ${ok}/${targets.length} llm_rows gemini=${geminiCallCount()} qloo=${observedQlooCalls()}`,
  );
  await prisma.$disconnect();
}

const invoked =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("warm-presets.ts") || process.argv[1].endsWith("warm-presets.js"));
if (invoked) void main();

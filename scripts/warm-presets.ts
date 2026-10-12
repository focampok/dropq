/**
 * Warm pinned presets into PackCache, or `--check` the stored rows (no network).
 * Never replaces an LLM-narrated row with a template one.
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

const LOCALES = ["en", "es"] as const;
const GEMINI_BUDGET = 25;
const WARM_ATTEMPTS = 3;
const WARM_RETRY_PAUSE_MS = 2_000;

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

async function checkMode(): Promise<number> {
  let failed = 0;
  for (const preset of PINNED_PRESETS) {
    for (const locale of LOCALES) {
      const entityIds = preset.seeds.map((seed) => seed.entityId!).filter(Boolean);
      const signature = packSignature({
        entityIds,
        city: preset.city,
        eventKind: preset.eventKind,
        locale,
        mode: "default",
      });
      const row = await prisma.packCache.findUnique({ where: { signature } });
      const result = evaluateWarmCheck({
        presetId: preset.id,
        locale,
        row: row
          ? { payload: row.payload as unknown as PackCachePayload, builtAt: row.builtAt }
          : null,
      });
      if (!result.ok) failed += 1;
      console.log(
        [
          result.presetId,
          result.locale,
          result.builtAt ?? "missing",
          result.ageHours == null ? "age=n/a" : `age_h=${result.ageHours}`,
          `A=${result.narration.A}`,
          `B=${result.narration.B}`,
          `modelA=${result.modelUsed.A ?? "none"}`,
          `modelB=${result.modelUsed.B ?? "none"}`,
          result.ok ? "ok" : `fail:${result.reason}`,
        ].join(" "),
      );
    }
  }
  return failed > 0 ? 1 : 0;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildOnce(
  preset: (typeof PINNED_PRESETS)[number],
  locale: (typeof LOCALES)[number],
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
    console.log(`${preset.id}/${locale} stopped ${safe}`);
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

async function warmOne(
  preset: (typeof PINNED_PRESETS)[number],
  locale: (typeof LOCALES)[number],
): Promise<"ok" | "stopped" | "needs_rewarm"> {
  const started = Date.now();
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

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (geminiCallCount() >= GEMINI_BUDGET) {
      console.log(`stopped gemini_budget=${GEMINI_BUDGET}`);
      return "stopped";
    }
    const quota = qlooQuota();
    if (quota.blocked || (quota.remaining !== undefined && quota.remaining < QLOO_CUSTOM_RESERVE)) {
      console.log(`${preset.id}/${locale} skipped_quota_reserve`);
      return "stopped";
    }
    if (llmOn && geminiQuotaBlocked()) {
      console.log(`${preset.id}/${locale} stopped_quota_cooldown`);
      break;
    }

    const built = await buildOnce(preset, locale);
    if (!built) return "stopped";
    best = pickBetter(best, built);
    if (packNarrationGrade(best.payload) === "llm") break;
    if (llmOn && geminiQuotaBlocked()) break;
    if (attempt < attempts) await sleep(WARM_RETRY_PAUSE_MS);
  }

  if (!best) {
    console.log(`${preset.id}/${locale} empty`);
    return "needs_rewarm";
  }

  const result = await writePackCacheIfBetter({
    signature,
    payload: best.payload,
    qlooCalls: best.qlooCalls,
    isPreset: true,
  });
  const flag = result.grade === "template" ? " needs_rewarm" : "";
  console.log(
    `${preset.id}/${locale} ${result.wrote ? "cached" : "kept"} packs=${best.payload.packs.length} narration=${result.grade} qloo=${best.qlooCalls} gemini=${geminiCallCount()} ms=${Date.now() - started} preset=${detectPresetFromPayload(best.payload)}${flag}`,
  );
  return result.grade === "template" ? "needs_rewarm" : "ok";
}

async function main(): Promise<void> {
  if (existsSync(".env")) loadEnvFile(".env");
  const check = process.argv.includes("--check");
  if (check) {
    const code = await checkMode();
    await prisma.$disconnect();
    process.exit(code);
  }

  resetGeminiCallCount();
  if (!llmConfigured() || llmDisabled()) {
    console.log("warm skipped_no_llm");
    await prisma.$disconnect();
    return;
  }

  for (const preset of PINNED_PRESETS) {
    for (const locale of LOCALES) {
      const outcome = await warmOne(preset, locale);
      if (outcome === "stopped") {
        await prisma.$disconnect();
        return;
      }
    }
  }
  console.log(`warm done gemini=${geminiCallCount()} qloo=${observedQlooCalls()}`);
  await prisma.$disconnect();
}

const invoked =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("warm-presets.ts") || process.argv[1].endsWith("warm-presets.js"));
if (invoked) void main();

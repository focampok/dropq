import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { prisma } from "../src/lib/db";
import { QLOO_CUSTOM_RESERVE } from "../src/lib/config";
import { observedQlooCalls, qlooQuota } from "../src/lib/qloo/client";
import { geminiCallCount, resetGeminiCallCount } from "../src/lib/llm/gemini-chain";
import { PINNED_PRESETS } from "../src/lib/pipeline/config";
import { runPipeline } from "../src/lib/pipeline/run";
import {
  detectPresetFromPayload,
  packSignature,
  snapshotSessionPacks,
  writePackCache,
} from "../src/lib/pack/cache";
import { llmConfigured } from "../src/lib/llm/provider";

const LOCALES = ["en", "es"] as const;
const GEMINI_BUDGET = 25;

async function main(): Promise<void> {
  if (existsSync(".env")) loadEnvFile(".env");
  resetGeminiCallCount();
  if (!llmConfigured()) {
    console.log("warm skipped_no_llm");
    await prisma.$disconnect();
    return;
  }

  for (const preset of PINNED_PRESETS) {
    for (const locale of LOCALES) {
      if (geminiCallCount() >= GEMINI_BUDGET) {
        console.log(`stopped gemini_budget=${GEMINI_BUDGET}`);
        await prisma.$disconnect();
        return;
      }
      const quota = qlooQuota();
      if (quota.blocked || (quota.remaining !== undefined && quota.remaining < QLOO_CUSTOM_RESERVE)) {
        console.log(`${preset.id}/${locale} skipped_quota_reserve`);
        await prisma.$disconnect();
        return;
      }

      const started = Date.now();
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
        await prisma.$disconnect();
        return;
      }

      const snap = await snapshotSessionPacks(session.id);
      if (!snap) {
        console.log(`${preset.id}/${locale} empty`);
        continue;
      }
      const entityIds = preset.seeds.map((seed) => seed.entityId!).filter(Boolean);
      const signature = packSignature({
        entityIds,
        city: preset.city,
        eventKind: preset.eventKind,
        locale,
        mode: "default",
      });
      await writePackCache({
        signature,
        payload: snap,
        qlooCalls: Math.max(0, observedQlooCalls() - qlooBefore),
        isPreset: true,
      });
      console.log(
        `${preset.id}/${locale} cached packs=${snap.packs.length} qloo=${observedQlooCalls() - qlooBefore} gemini=${geminiCallCount()} ms=${Date.now() - started} preset=${detectPresetFromPayload(snap)}`,
      );
    }
  }
  console.log(`warm done gemini=${geminiCallCount()} qloo=${observedQlooCalls()}`);
  await prisma.$disconnect();
}

void main();

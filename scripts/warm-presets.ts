import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { prisma } from "../src/lib/db";
import { qlooQuota } from "../src/lib/qloo/client";
import { PINNED_PRESETS } from "../src/lib/pipeline/config";
import { runPipeline } from "../src/lib/pipeline/run";

async function main(): Promise<void> {
  if (existsSync(".env")) loadEnvFile(".env");
  for (const preset of PINNED_PRESETS) {
    if (qlooQuota().blocked) {
      console.log(`${preset.id} stopped_quota`);
      break;
    }
    const started = Date.now();
    const session = await prisma.session.create({
      data: {
        city: preset.city,
        eventKind: preset.eventKind,
        locale: "en",
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
      console.log(`${preset.id} stopped ${safe}`);
      break;
    }
    const packs = await prisma.pack.findMany({
      where: { sessionId: session.id },
      include: { items: true },
    });
    const items = packs.reduce((count, pack) => count + pack.items.length, 0);
    console.log(`${preset.id} packs=${packs.length} items=${items} ms=${Date.now() - started}`);
  }
  await prisma.$disconnect();
}

void main();

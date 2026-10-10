/**
 * Checks the image URLs stored in the last saved pack of each preset.
 *
 * It sends HEAD requests only, so no image body is ever downloaded, and it reports
 * by host name only. Each host is probed twice: once plain and once with a Referer,
 * because a hotlinked image can be blocked only in the second case.
 *
 *   pnpm verify:images
 */
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { prisma } from "../src/lib/db";
import { PINNED_PRESETS } from "../src/lib/pipeline/config";

if (existsSync(".env")) loadEnvFile(".env");

const SAMPLES_PER_HOST = 8;
const TIMEOUT_MS = 10_000;

type Probe = { status: number | string; contentType: string };

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

async function head(url: string, referer?: string): Promise<Probe> {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(referer ? { headers: { referer } } : {}),
    });
    // HEAD responses carry no body to drain; cancelling keeps the socket free.
    await response.body?.cancel();
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "(none)",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "error";
    return { status: `ERR ${message.slice(0, 40)}`, contentType: "—" };
  }
}

async function latestSessionFor(seeds: readonly string[]) {
  const wanted = [...seeds].sort();
  const sessions = await prisma.session.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { seeds: true, packs: { include: { items: { orderBy: { position: "asc" } } } } },
  });
  return sessions.find((session) => {
    const got = session.seeds.map((seed) => seed.rawText).sort();
    return got.length === wanted.length && got.every((text, index) => text === wanted[index]);
  });
}

async function main(): Promise<void> {
  const rows: string[] = [];
  const hostSamples = new Map<string, string[]>();
  const totals = new Map<string, { withImage: number; total: number }>();

  for (const preset of PINNED_PRESETS) {
    const session = await latestSessionFor(preset.seeds.map((seed) => seed.rawText));
    if (!session) {
      rows.push(`| ${preset.id} | no saved pack | — | — |`);
      continue;
    }
    const counts = new Map<string, { withImage: number; total: number }>();
    for (const pack of session.packs) {
      for (const item of pack.items) {
        const bucket = counts.get(item.slot) ?? { withImage: 0, total: 0 };
        bucket.total += 1;
        if (item.imageUrl) bucket.withImage += 1;
        counts.set(item.slot, bucket);
      }
    }
    for (const [slot, bucket] of counts) {
      const total = totals.get(slot) ?? { withImage: 0, total: 0 };
      totals.set(slot, { withImage: total.withImage + bucket.withImage, total: total.total + bucket.total });
    }
    for (const pack of session.packs) {
      for (const item of pack.items) {
        if (!item.imageUrl) continue;
        const host = hostOf(item.imageUrl);
        if (!host) continue;
        const list = hostSamples.get(host) ?? [];
        if (list.length < SAMPLES_PER_HOST && !list.includes(item.imageUrl)) list.push(item.imageUrl);
        hostSamples.set(host, list);
      }
    }
    const perSlot = [...counts.entries()].map(([slot, bucket]) => `${slot} ${bucket.withImage}/${bucket.total}`);
    rows.push(`| ${preset.id} | pack ${session.id.slice(0, 8)} | ${perSlot.join(", ")} | ${session.packs.length} plans |`);
  }

  console.log("Preset packs and image coverage");
  console.log("| preset | session | cards with image per slot | plans |");
  console.log("| --- | --- | --- | --- |");
  for (const row of rows) console.log(row);

  console.log("");
  console.log("Host probes (HEAD, no bodies)");
  console.log("| host | plain status | plain content-type | with Referer status | with Referer content-type |");
  console.log("| --- | --- | --- | --- | --- |");
  const perHost = new Map<string, { ok: number; probed: number }>();
  for (const [host, samples] of hostSamples) {
    for (const url of samples) {
      const plain = await head(url);
      const referred = await head(url, "https://dropq.example/");
      const ok = plain.status === 200 && plain.contentType.startsWith("image/");
      const tally = perHost.get(host) ?? { ok: 0, probed: 0 };
      tally.probed += 1;
      if (ok) tally.ok += 1;
      perHost.set(host, tally);
      console.log(
        `| ${host}/${tally.probed} | ${plain.status} | ${plain.contentType} | ${referred.status} | ${referred.contentType} |`,
      );
    }
  }
  console.log("");
  for (const [host, tally] of perHost) {
    console.log(`${host}: ${tally.ok}/${tally.probed} sampled URLs returned an image without a Referer.`);
  }

  console.log("");
  console.log(
    `Slots over every preset: ${[...totals.entries()].map(([slot, bucket]) => `${slot} ${bucket.withImage}/${bucket.total}`).join(", ") || "(none)"}`,
  );
  console.log(`Hosts serving images: ${[...hostSamples.keys()].join(", ") || "(none)"}`);
  await prisma.$disconnect();
}

void main();

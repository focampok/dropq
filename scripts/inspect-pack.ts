/**
 * Read-only inspector for a stored preset pack row.
 *
 * Usage: pnpm tsx scripts/inspect-pack.ts <presetId> <en|es>
 *
 * Prints slot, name, entity id, whether tags are in entity_tag_cache (boolean),
 * and which wear-exclusion keywords match (keyword names only). Never prints
 * environment values, hosts, or secrets.
 */
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { prisma } from "../src/lib/db";
import { PACK_CACHE_PRESET_TTL_HOURS } from "../src/lib/config";
import { packNarrationGrade, packSignature, type PackCachePayload } from "../src/lib/pack/cache";
import { PINNED_PRESETS, WEAR_EXCLUDE_TAG_KEYWORDS } from "../src/lib/pipeline/config";
import { normalizeForMatch } from "../src/lib/pipeline/tags";

function hitTags(evidence: unknown): string[] {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return [];
  const tags = (evidence as { hitTags?: unknown }).hitTags;
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is string => typeof tag === "string");
}

function matchingKeywords(name: string, tags: readonly string[]): string[] {
  const haystacks = [normalizeForMatch(name), ...tags.map((tag) => normalizeForMatch(tag))];
  const hits: string[] = [];
  for (const keyword of WEAR_EXCLUDE_TAG_KEYWORDS) {
    const needle = ` ${normalizeForMatch(keyword)} `;
    if (haystacks.some((hay) => ` ${hay} `.includes(needle))) hits.push(keyword);
  }
  return hits;
}

async function main(): Promise<void> {
  if (existsSync(".env")) loadEnvFile(".env");
  const presetId = process.argv[2]?.trim();
  const locale = process.argv[3]?.trim() === "es" ? "es" : process.argv[3]?.trim() === "en" ? "en" : null;
  if (!presetId || !locale) {
    console.error("usage: pnpm tsx scripts/inspect-pack.ts <presetId> <en|es>");
    process.exit(2);
  }
  const preset = PINNED_PRESETS.find((row) => row.id === presetId);
  if (!preset) {
    console.error(`unknown preset; known: ${PINNED_PRESETS.map((row) => row.id).join(", ")}`);
    process.exit(2);
  }
  const entityIds = preset.seeds.map((seed) => seed.entityId!).filter(Boolean);
  const signature = packSignature({
    entityIds,
    city: preset.city,
    eventKind: preset.eventKind,
    locale,
    mode: "default",
  });
  const row = await prisma.packCache.findUnique({ where: { signature } });
  if (!row) {
    console.log(`inspect ${presetId}/${locale} present=false`);
    await prisma.$disconnect();
    process.exit(1);
  }
  const payload = row.payload as unknown as PackCachePayload;
  const ageHours = (Date.now() - row.builtAt.getTime()) / 3_600_000;
  const freshness = ageHours > PACK_CACHE_PRESET_TTL_HOURS ? "stale" : "fresh";
  const grade = packNarrationGrade(payload);
  console.log(
    [
      `inspect ${presetId}/${locale}`,
      `present=true`,
      `plans=${payload.packs.length}`,
      `grade=${grade}`,
      `age_h=${Math.round(ageHours * 10) / 10}`,
      `ttl=${freshness}`,
      `builtAt=${row.builtAt.toISOString()}`,
    ].join(" "),
  );
  for (const plan of payload.packs) {
    const llm = plan.coverage && typeof plan.coverage === "object" && !Array.isArray(plan.coverage)
      ? (plan.coverage as { llm?: { narrative?: unknown } }).llm
      : null;
    const narration = llm?.narrative === "llm" ? "llm" : "template";
    console.log(
      `plan ${plan.label} axis=${plan.axis} cards=${plan.items.length} narration=${narration}`,
    );
    for (const item of plan.items) {
      const tags = hitTags(item.evidence);
      const cached = await prisma.entityTagCache.findUnique({
        where: { entityId: item.qlooEntityId },
        select: { entityId: true },
      });
      const keywords = matchingKeywords(item.qlooName, tags);
      console.log(
        [
          `  ${plan.label}/${item.slot}`,
          `name=${JSON.stringify(item.qlooName)}`,
          `entityId=${item.qlooEntityId}`,
          `tagCache=${Boolean(cached)}`,
          `hitTagCount=${tags.length}`,
          `excludeKeywords=${keywords.length ? keywords.join(",") : "none"}`,
        ].join(" "),
      );
    }
  }
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "inspect failed");
  process.exit(1);
});

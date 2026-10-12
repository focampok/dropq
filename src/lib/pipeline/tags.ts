import { SEED_FAMILY_MIN_NAME_LENGTH, WEAR_EXCLUDE_TAG_KEYWORDS } from "@/lib/pipeline/config";
import type { PackSlot } from "@/lib/pipeline/requests";

/** How many distinct tags a card shows before the "+N more" control. */
export const TAG_PREVIEW_LIMIT = 8;

/**
 * Qloo repeats the same tag across a hit, so "Energetic" arrived four times on one card.
 * Distinct, case-insensitive and trimmed, keeping the first spelling that showed up.
 */
export function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * What a tag row shows before the "+N more" control: the first `limit` distinct tags and
 * how many are left. Display-only — the stored list keeps every tag Qloo returned.
 */
export function tagPreview(
  tags: readonly string[],
  limit = TAG_PREVIEW_LIMIT,
): { shown: string[]; hidden: number } {
  const distinct = dedupeTags(tags);
  return {
    shown: distinct.slice(0, limit),
    hidden: Math.max(0, distinct.length - limit),
  };
}

/** Lowercased, accent-free, single-spaced: the form every name match works on. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Whole-word containment on the normalized strings, so "app" never matches "apparel". */
function containsWholeWords(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/** Seed names long enough to be matched; a 2-letter seed would match half the catalog. */
export function normalizeSeedNames(seedNames: readonly string[]): string[] {
  return seedNames
    .map((name) => normalizeForMatch(name))
    .filter((name) => name.replace(/ /g, "").length >= SEED_FAMILY_MIN_NAME_LENGTH);
}

/** "Nike Training Club" carries the seed "Nike": the seed's own family, not a discovery. */
export function isSeedFamilyName(name: string, normalizedSeeds: readonly string[]): boolean {
  const normalized = normalizeForMatch(name);
  if (!normalized) return false;
  return normalizedSeeds.some((seed) => containsWholeWords(normalized, seed));
}

/** True when a candidate's tags mark it as something nobody can wear. */
export function wearTagsExcluded(tags: readonly string[]): boolean {
  return tags.some((tag) => {
    const normalized = normalizeForMatch(tag);
    return WEAR_EXCLUDE_TAG_KEYWORDS.some((keyword) => containsWholeWords(normalized, keyword));
  });
}

export type SlotFilterFallback = "seed_family" | "wear_tags";

export type SlotFilterResult<T> = {
  cards: T[];
  seedFamilyDropped: string[];
  wearTagsDropped: string[];
  /** Set when a filter would have emptied the slot and the best unfiltered card was kept. */
  keptFallback: SlotFilterFallback | null;
};

/**
 * Client-side filters over the list Qloo already returned, so neither costs a request.
 * Every slot drops the seeds' own family; `wear` also drops candidates whose tags say
 * they are not wearable. A filter never empties a slot: when it would, the best card the
 * unfiltered list offered is kept and the reason is reported in `coverage`.
 */
export function filterSlotCards<T extends { name: string; tags: string[] }>(
  slot: PackSlot,
  cards: readonly T[],
  seedNames: readonly string[],
): SlotFilterResult<T> {
  const normalizedSeeds = normalizeSeedNames(seedNames);
  const seedFamilyDropped: string[] = [];
  const keptBySeed: T[] = [];
  for (const card of cards) {
    if (isSeedFamilyName(card.name, normalizedSeeds)) seedFamilyDropped.push(card.name);
    else keptBySeed.push(card);
  }
  if (keptBySeed.length === 0) {
    return {
      cards: [...cards],
      seedFamilyDropped: [],
      wearTagsDropped: [],
      keptFallback: cards.length > 0 ? "seed_family" : null,
    };
  }
  if (slot !== "wear") {
    return { cards: keptBySeed, seedFamilyDropped, wearTagsDropped: [], keptFallback: null };
  }

  const wearTagsDropped: string[] = [];
  const keptByTags: T[] = [];
  for (const card of keptBySeed) {
    if (wearTagsExcluded(card.tags)) wearTagsDropped.push(card.name);
    else keptByTags.push(card);
  }
  if (keptByTags.length === 0) {
    return { cards: keptBySeed, seedFamilyDropped, wearTagsDropped: [], keptFallback: "wear_tags" };
  }
  return { cards: keptByTags, seedFamilyDropped, wearTagsDropped, keptFallback: null };
}

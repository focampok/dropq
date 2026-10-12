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

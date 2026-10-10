export type AnchorCandidate = {
  id: string;
  name: string;
  slot: "watch" | "listen" | "wear";
  tags: string[];
  /** Full-list overlap stored at generation time. Ranking prefers this over truncated tags. */
  sharedTagCount?: number;
};

/** Order used only when fewer than two candidates share a tag with the seeds. */
const FALLBACK_ORDER = ["listen", "wear", "watch"] as const;

export function countSharedTags(tags: readonly string[], seedTags: Set<string>): number {
  const seen = new Set<string>();
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    if (seedTags.has(lower)) seen.add(lower);
  }
  return seen.size;
}

export function sharedTagCount(candidate: AnchorCandidate, seedTags: Set<string>): number {
  if (typeof candidate.sharedTagCount === "number" && Number.isFinite(candidate.sharedTagCount)) {
    return candidate.sharedTagCount;
  }
  return countSharedTags(candidate.tags, seedTags);
}

/**
 * Ranks Roots candidates by how many distinct tags they share with the seed anchors.
 * When at least two candidates share a tag, only those are used (up to three, one per
 * slot); otherwise it falls back to the top hit per slot in FALLBACK_ORDER.
 */
export function deterministicAnchors(
  candidates: AnchorCandidate[],
  seedTags: Set<string> = new Set(),
): string[] {
  const ranked = candidates
    .map((candidate) => ({ candidate, shared: sharedTagCount(candidate, seedTags) }))
    .sort((left, right) => right.shared - left.shared);
  const chosen: string[] = [];
  const usedSlots = new Set<string>();
  const take = (entries: typeof ranked) => {
    for (const entry of entries) {
      if (chosen.length === 3) return;
      if (usedSlots.has(entry.candidate.slot)) continue;
      if (chosen.includes(entry.candidate.id)) continue;
      chosen.push(entry.candidate.id);
      usedSlots.add(entry.candidate.slot);
    }
  };

  const qualifying = ranked.filter((entry) => entry.shared > 0);
  if (qualifying.length >= 2) {
    take(qualifying);
    return chosen;
  }
  for (const slot of FALLBACK_ORDER) {
    const entry = ranked.find((candidate) => candidate.candidate.slot === slot);
    if (!entry || chosen.includes(entry.candidate.id) || usedSlots.has(slot)) continue;
    chosen.push(entry.candidate.id);
    usedSlots.add(slot);
    if (chosen.length === 3) break;
  }
  return chosen;
}

export function validAnchorIds(candidates: AnchorCandidate[], ids: string[]): string[] | null {
  if (ids.length < 2 || ids.length > 3) return null;
  const slots = new Set<string>();
  for (const id of ids) {
    const match = candidates.find((candidate) => candidate.id === id);
    if (!match) return null;
    if (slots.has(match.slot)) return null;
    slots.add(match.slot);
  }
  return ids;
}

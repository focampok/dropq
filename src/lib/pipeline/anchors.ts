import {
  BRIDGE_ANCHOR_RULE,
  WATCH_ANCHOR_MIN_SHARED,
  confidenceForSharedTags,
} from "@/lib/pipeline/config";

export type AnchorCandidate = {
  id: string;
  name: string;
  slot: "watch" | "listen" | "wear";
  tags: string[];
  /** Full-list overlap stored at generation time. Ranking prefers this over truncated tags. */
  sharedTagCount?: number;
  /** Position inside the Roots result for this slot. Ties break on it, then on id. */
  rank?: number;
};

export type AnchorConfidence = "high" | "medium" | "low";

export type RankedAnchor = {
  id: string;
  name: string;
  slot: AnchorCandidate["slot"];
  sharedTags: string[];
  sharedTagCount: number;
  confidence: AnchorConfidence;
};

/** Order used only when fewer than two candidates share a tag with the seeds. */
const FALLBACK_ORDER = ["listen", "wear", "watch"] as const;

/** How many ranked candidates the LLM is allowed to choose from. */
export const ANCHOR_CLOSED_LIST_SIZE = 6;

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

/** Only the tag names actually present on the candidate are ever reported. */
export function sharedTagNames(candidate: AnchorCandidate, seedTags: Set<string>): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const tag of candidate.tags) {
    const lower = tag.toLowerCase();
    if (!seedTags.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    names.push(tag);
  }
  return names;
}

/** high at 3 or more shared tags, medium at 2, low at 1 or none — the one confidence rule. */
export function anchorConfidence(shared: number): AnchorConfidence {
  return confidenceForSharedTags(shared);
}

/**
 * Ties break on (1) more shared tags, (2) Qloo rank order inside the Roots result,
 * (3) lexical id order, so the same input always yields the same anchors.
 */
export function rankAnchors(
  candidates: AnchorCandidate[],
  seedTags: Set<string> = new Set(),
): RankedAnchor[] {
  return candidates
    .map((candidate, index) => {
      const shared = sharedTagCount(candidate, seedTags);
      return {
        id: candidate.id,
        name: candidate.name,
        slot: candidate.slot,
        sharedTags: sharedTagNames(candidate, seedTags),
        sharedTagCount: shared,
        confidence: anchorConfidence(shared),
        rank: candidate.rank ?? index,
      };
    })
    .sort(
      (left, right) =>
        right.sharedTagCount - left.sharedTagCount ||
        left.rank - right.rank ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      slot: entry.slot,
      sharedTags: entry.sharedTags,
      sharedTagCount: entry.sharedTagCount,
      confidence: entry.confidence,
    }));
}

/**
 * The closed list handed to the LLM: the top candidates as rule B ranks them.
 * Candidates with no shared tag are dropped whenever two others do share one,
 * which is the case where rule B's evidence is strong enough to be trusted.
 */
export function closedAnchorList(
  candidates: AnchorCandidate[],
  seedTags: Set<string> = new Set(),
  limit = ANCHOR_CLOSED_LIST_SIZE,
): RankedAnchor[] {
  const ranked = rankAnchors(candidates, seedTags);
  const withShared = ranked.filter((anchor) => anchor.sharedTagCount > 0);
  const pool = withShared.length >= 2 ? withShared : ranked;
  return pool.slice(0, limit);
}

function bestInSlot(
  candidates: AnchorCandidate[],
  slot: "listen" | "wear" | "watch",
  seedTags: Set<string>,
): RankedAnchor | null {
  return rankAnchors(candidates, seedTags).find((anchor) => anchor.slot === slot) ?? null;
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
  const ranked = rankAnchors(candidates, seedTags);
  const chosen: string[] = [];
  const usedSlots = new Set<string>();
  const take = (entries: RankedAnchor[]) => {
    for (const entry of entries) {
      if (chosen.length === 3) return;
      if (usedSlots.has(entry.slot)) continue;
      if (chosen.includes(entry.id)) continue;
      chosen.push(entry.id);
      usedSlots.add(entry.slot);
    }
  };

  const qualifying = ranked.filter((entry) => entry.sharedTagCount > 0);
  if (qualifying.length >= 2) {
    take(qualifying);
    return chosen;
  }
  for (const slot of FALLBACK_ORDER) {
    const entry = ranked.find((candidate) => candidate.slot === slot);
    if (!entry || chosen.includes(entry.id) || usedSlots.has(entry.slot)) continue;
    chosen.push(entry.id);
    usedSlots.add(entry.slot);
    if (chosen.length === 3) break;
  }
  return chosen;
}

/**
 * Rule B takes the strongest listen and wear, plus watch when it clears the shared-tag
 * minimum. Do is never an anchor. Fewer than two anchors falls back to rule A.
 */
export function anchorsForRule(
  candidates: AnchorCandidate[],
  seedTags: Set<string> = new Set(),
  rule: "A" | "B" = BRIDGE_ANCHOR_RULE,
): string[] {
  if (rule === "A") return deterministicAnchors(candidates, seedTags);
  const chosen: string[] = [];
  const listen = bestInSlot(candidates, "listen", seedTags);
  const wear = bestInSlot(candidates, "wear", seedTags);
  if (listen) chosen.push(listen.id);
  if (wear) chosen.push(wear.id);
  const watch = bestInSlot(candidates, "watch", seedTags);
  if (watch && watch.sharedTagCount >= WATCH_ANCHOR_MIN_SHARED) chosen.push(watch.id);
  if (chosen.length < 2) return deterministicAnchors(candidates, seedTags);
  return chosen;
}

/** The rule-B evidence for the anchors that were actually used. */
export function anchorEvidence(
  candidates: AnchorCandidate[],
  ids: readonly string[],
  seedTags: Set<string> = new Set(),
): RankedAnchor[] {
  const ranked = rankAnchors(candidates, seedTags);
  return ids.flatMap((id) => {
    const match = ranked.find((anchor) => anchor.id === id);
    return match ? [match] : [];
  });
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

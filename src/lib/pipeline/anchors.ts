export type AnchorCandidate = {
  id: string;
  name: string;
  slot: "watch" | "listen" | "wear";
  tags: string[];
};

const ORDER = ["watch", "listen", "wear"] as const;

export function deterministicAnchors(candidates: AnchorCandidate[]): string[] {
  const ids: string[] = [];
  for (const slot of ORDER) {
    const hit = candidates.find((candidate) => candidate.slot === slot);
    if (!hit || ids.includes(hit.id)) continue;
    ids.push(hit.id);
    if (ids.length === 3) break;
  }
  return ids;
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

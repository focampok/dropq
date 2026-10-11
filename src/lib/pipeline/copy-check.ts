/**
 * The worked reply teaches the JSON shape with tokens. Its words belong to a
 * fictional farmers market, so a model that copies them is visible against a night-out pack.
 */
export const NARRATIVE_WORKED_EXAMPLE = {
  rootsNarrative: "The Saturday farmers market opens with [[watch]] beside the [[listen]] stall.",
  rootsHeadline: "[[watch]] on the green",
  bridgeNarrative: "After the last stall the crowd follows [[wear]] toward [[do]] past [[anchor1]].",
  bridgeHeadline: "[[do]] after the stalls",
} as const;

export function workedExampleText(): string {
  return Object.values(NARRATIVE_WORKED_EXAMPLE).join(" ");
}

export function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

export function sharesWordSequence(left: string, right: string, size = 6): boolean {
  const a = wordsOf(left);
  const b = wordsOf(right);
  if (a.length < size || b.length < size) return false;
  const grams = new Set<string>();
  for (let index = 0; index <= a.length - size; index += 1) grams.add(a.slice(index, index + size).join(" "));
  for (let index = 0; index <= b.length - size; index += 1) {
    if (grams.has(b.slice(index, index + size).join(" "))) return true;
  }
  return false;
}

/** Share of the longer text's words that also appear in the other, in order of consumption. */
export function wordOverlapRatio(left: string, right: string): number {
  const a = wordsOf(left);
  const b = wordsOf(right);
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const word of a) counts.set(word, (counts.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of b) {
    const remaining = counts.get(word) ?? 0;
    if (remaining > 0) {
      shared += 1;
      counts.set(word, remaining - 1);
    }
  }
  return shared / Math.max(a.length, b.length);
}

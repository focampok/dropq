import { placeTagExcluded } from "@/lib/pack/assemble";

export type PlaceCard = {
  entityId: string;
  name: string;
  tags: string[];
};

export type PlaceStages = {
  raw: number;
  named: number;
  afterLodging: number;
  afterRoots: number;
};

export type PlaceOutcome<T extends PlaceCard> = {
  cards: T[];
  first: PlaceStages;
  attempt: PlaceStages;
  retried: boolean;
};

/** assemblePack only inspects the first eight tags, so the count must use the same window. */
const LODGING_TAG_WINDOW = 8;

function isLodging(card: PlaceCard): boolean {
  return card.tags.slice(0, LODGING_TAG_WINDOW).some((tag) => placeTagExcluded(tag));
}

function isUsable(card: PlaceCard, rootsIds: Set<string>): boolean {
  return Boolean(card.entityId.trim() && card.name.trim()) && !rootsIds.has(card.entityId) && !isLodging(card);
}

export function placeStages<T extends PlaceCard>(raw: T[], rootsIds: Set<string>): PlaceStages {
  const named = raw.filter((card) => card.entityId.trim() && card.name.trim());
  const afterLodging = named.filter((card) => !isLodging(card));
  const afterRoots = afterLodging.filter((card) => !rootsIds.has(card.entityId));
  return {
    raw: raw.length,
    named: named.length,
    afterLodging: afterLodging.length,
    afterRoots: afterRoots.length,
  };
}

/**
 * Fetches the place slot without filter.exclude.entities and drops Roots ids here
 * instead. Retries once at the wider radius when the first window leaves nothing,
 * and returns an empty list once both attempts are exhausted.
 */
export async function fillPlaceSlot<T extends PlaceCard>(input: {
  load: (radius?: number) => Promise<T[]>;
  rootsIds: Set<string>;
  fallbackRadius: number;
}): Promise<PlaceOutcome<T>> {
  const firstCards = await input.load();
  const first = placeStages(firstCards, input.rootsIds);
  if (first.afterRoots > 0) {
    return { cards: firstCards.filter((card) => isUsable(card, input.rootsIds)), first, attempt: first, retried: false };
  }
  const retryCards = await input.load(input.fallbackRadius);
  const attempt = placeStages(retryCards, input.rootsIds);
  return {
    cards: retryCards.filter((card) => isUsable(card, input.rootsIds)),
    first,
    attempt,
    retried: true,
  };
}

export function placeOmittedNote(
  first: PlaceStages,
  attempt: PlaceStages,
  fallbackRadius: number,
): { en: string; es: string } {
  return {
    en: `Do was omitted: ${first.raw} raw hits, ${first.afterLodging} after the lodging net, ${first.afterRoots} after removing Roots ids. Retried once at ${fallbackRadius} m (${attempt.raw} raw hits, ${attempt.afterRoots} usable).`,
    es: `Hacer se omitió: ${first.raw} resultados crudos, ${first.afterLodging} tras el filtro de hospedaje, ${first.afterRoots} tras quitar los ids de Raíz. Se reintentó una vez a ${fallbackRadius} m (${attempt.raw} resultados crudos, ${attempt.afterRoots} utilizables).`,
  };
}

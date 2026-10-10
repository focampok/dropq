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
  tagSetIndex: number;
  usedFallback: boolean;
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
 * instead. Each category set is tried at the base radius and then once wider, and the
 * next set is only tried when the previous one left nothing usable, so a slot that
 * fills on the first set costs exactly the calls it always did.
 */
export async function fillPlaceSlot<T extends PlaceCard>(input: {
  load: (request: { radius?: number; tags: string[] }) => Promise<T[]>;
  rootsIds: Set<string>;
  fallbackRadius: number;
  tagSets: string[][];
}): Promise<PlaceOutcome<T>> {
  const sets = input.tagSets.length > 0 ? input.tagSets : [[]];
  let first: PlaceStages | null = null;
  let attempt: PlaceStages | null = null;
  let retried = false;
  let tagSetIndex = 0;

  for (const [index, tags] of sets.entries()) {
    const cards = await input.load({ tags });
    const stages = placeStages(cards, input.rootsIds);
    if (first === null) first = stages;
    if (stages.afterRoots > 0) {
      return {
        cards: cards.filter((card) => isUsable(card, input.rootsIds)),
        first,
        attempt: stages,
        retried,
        tagSetIndex: index,
        usedFallback: index > 0,
      };
    }
    const retryCards = await input.load({ radius: input.fallbackRadius, tags });
    const retryStages = placeStages(retryCards, input.rootsIds);
    attempt = retryStages;
    retried = true;
    tagSetIndex = index;
    if (retryStages.afterRoots > 0) {
      return {
        cards: retryCards.filter((card) => isUsable(card, input.rootsIds)),
        first,
        attempt: retryStages,
        retried: true,
        tagSetIndex: index,
        usedFallback: index > 0,
      };
    }
  }

  return {
    cards: [],
    first: first ?? placeStages([], input.rootsIds),
    attempt: attempt ?? placeStages([], input.rootsIds),
    retried,
    tagSetIndex,
    usedFallback: tagSetIndex > 0,
  };
}

export function placeOmittedNote(
  first: PlaceStages,
  attempt: PlaceStages,
  fallbackRadius: number,
  extra?: { sets: number },
): { en: string; es: string } {
  const scope = extra && extra.sets > 1 ? ` across ${extra.sets} category sets` : "";
  const scopeEs = extra && extra.sets > 1 ? ` en ${extra.sets} conjuntos de categorías` : "";
  return {
    en: `Do was omitted${scope}: ${first.raw} raw hits, ${first.afterLodging} after the lodging net, ${first.afterRoots} after removing Roots ids. Last attempt at ${fallbackRadius} m gave ${attempt.raw} raw hits and ${attempt.afterRoots} usable.`,
    es: `Hacer se omitió${scopeEs}: ${first.raw} resultados crudos, ${first.afterLodging} tras el filtro de hospedaje, ${first.afterRoots} tras quitar los ids de Raíz. El último intento a ${fallbackRadius} m dio ${attempt.raw} resultados crudos y ${attempt.afterRoots} utilizables.`,
  };
}

export function placeFallbackNote(tagSetIndex: number): { en: string; es: string } | null {
  if (tagSetIndex === 0) return null;
  return {
    en: "Do came from the second category set because the first left the slot empty.",
    es: "Hacer vino del segundo conjunto de categorías porque el primero dejó el espacio vacío.",
  };
}

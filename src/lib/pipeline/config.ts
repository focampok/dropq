/**
 * Bumped whenever the pack the pipeline builds changes shape or contents. It is part of
 * the pack-cache signature, so a pack cached by an older pipeline is a miss and is rebuilt
 * instead of being served under a stale shape. Bumped in pass 3i: the evidence panel, the
 * one confidence rule, the seed-family and wear filters, the seed reference tags and the
 * Spanish narration rule all change the stored cards.
 */
export const PIPELINE_VERSION = "3i";

export const PLACE_STRATEGY: "s1" | "s2" | "s3" | "none" = "s3";
export const PLACE_TIMEOUT_MS = 8000;
export const BRIDGE_VARIANT: "a" | "b" | "c" = "a";
export const USE_EXPLAINABILITY = true;
export const PLACE_RADIUS_METERS = 20000;

/** One-shot retry radius when the place slot has no usable hit inside PLACE_RADIUS_METERS. */
export const PLACE_RADIUS_FALLBACK_M = 40000;

/**
 * R7 live-night without anchors: lodging 20% Los Angeles, 10% Houston, 0% New York,
 * 10 results in each city. Anchored lists of the same URNs stayed at 40%.
 * restaurant-bar never dropped under 30% (open 40/30/80). The con museum set
 * had 0% lodging but Houston returned 4 hits, short of 5. Every kind uses this set.
 */
export const PLACE_CATEGORY_TAGS: Record<
  "tour" | "con" | "comunidad",
  readonly string[] | null
> = {
  tour: ["urn:tag:category:place:live_music_venue", "urn:tag:genre:place:nightlife"],
  con: ["urn:tag:category:place:live_music_venue", "urn:tag:genre:place:nightlife"],
  comunidad: ["urn:tag:category:place:live_music_venue", "urn:tag:genre:place:nightlife"],
};

/**
 * Second place category set, tried only when the first leaves the slot with nothing
 * usable. Hop 1 for `do` sends the same city request as hop 0, so the New York con
 * list comes back identical and every hit is already a Roots id; a different category
 * set is the only way the Bridge can pick up a venue of its own. Verified against
 * /v2/tags under urn:tag:category:place:*, and only tags that exist there are listed.
 */
export const PLACE_CATEGORY_TAGS_FALLBACK: Record<
  "tour" | "con" | "comunidad",
  readonly string[] | null
> = {
  tour: [
    "urn:tag:category:place:comic_book_store",
    "urn:tag:category:place:hobby_store",
    "urn:tag:category:place:record_store",
  ],
  con: [
    "urn:tag:category:place:comic_book_store",
    "urn:tag:category:place:hobby_store",
    "urn:tag:category:place:record_store",
  ],
  comunidad: [
    "urn:tag:category:place:comic_book_store",
    "urn:tag:category:place:hobby_store",
    "urn:tag:category:place:record_store",
  ],
};

/** R7 live-night with anchors was 40% lodging in Los Angeles, Houston, and New York. */
export const PLACE_USE_ANCHORS = false;

/** Same keywords used to count lodging in R7. Last filter on the do slot. */
export const DO_EXCLUDE_TAG_KEYWORDS = ["hotel", "lodging", "resort", "motel", "inn", "suites"] as const;

/**
 * Whether the Bridge's hop-1 request for a slot sends
 * `signal.location.query=<destination city>`. Roots never does.
 *
 * T4 probe: the three presets, the `listen`, `watch` and `wear` slots, the anchors the
 * stored packs used, the same `take`, with and without the parameter (18 requests).
 *   listen  changed 100% / 46% / 100% of the list.
 *           With it, Los Angeles answers with its Latin circuit (Los Bukis, Juan Gabriel,
 *           Café Tacvba) and New York with Mitski and Rina Sawayama — names of those
 *           scenes. Without it, both fall back to generic Latin pop and to Japanese acts.
 *   watch   changed 100% / 89% / 89%.
 *           With it Los Angeles returns Gentefied, a show set in the city, and Houston a
 *           contemporary American list instead of 1970s sports dramas. Judgement call: the
 *           New York anime list reads slightly better without it.
 *   wear    changed 100% / 89% / 95%.
 *           Only the city list avoids the anchor's own family — Nike in Houston,
 *           Crunchyroll in New York — and the noisy Cheetos / Diet Pepsi / Playstation
 *           set R7 flagged.
 * The bar in the pass brief (at least 40% of the list changes and a city-tied name sits in
 * the top five) is met for all three, so all three stay on. The flag exists so that is a
 * recorded decision, not an accident, and so a future probe can turn one off.
 */
export const BRIDGE_USE_LOCATION: Record<"listen" | "watch" | "wear", boolean> = {
  listen: true,
  watch: true,
  wear: true,
};

/**
 * One confidence rule for every card that has a reference set: the number of
 * *distinct* shared tags. Roots items are measured against the seed anchors; Bridge
 * items against the anchor that produced them (their own confidence is capped by it).
 * The label is never a claim about how good the pick is beyond that overlap.
 */
export const CONFIDENCE_SHARED_HIGH_MIN = 3;
export const CONFIDENCE_SHARED_MEDIUM_MIN = 2;

export type SharedConfidence = "high" | "medium" | "low";

export function confidenceForSharedTags(distinctShared: number): SharedConfidence {
  if (distinctShared >= CONFIDENCE_SHARED_HIGH_MIN) return "high";
  if (distinctShared >= CONFIDENCE_SHARED_MEDIUM_MIN) return "medium";
  return "low";
}

/**
 * The `wear` slot must return something a person can actually put on. Each keyword is
 * matched as a whole word against a candidate's tags, so "app" never matches "apparel"
 * (verified by test). Applied client-side to the list Qloo already returned: no extra call.
 */
export const WEAR_EXCLUDE_TAG_KEYWORDS = [
  "mobile app",
  "app",
  "software",
  "video game",
  "gaming",
  "console",
  "beverage",
  "soft drink",
  "snack",
  "food",
  "restaurant",
  "delivery",
  "streaming",
  "insurance",
  "bank",
  "airline",
  "hotel",
  "telecom",
] as const;

/**
 * A candidate whose name carries a seed's name is the seed's own family, not a
 * discovery: "Nike Training Club" for the seed "Nike". Shorter seed names are ignored
 * so a three-letter fragment cannot match by accident.
 */
export const SEED_FAMILY_MIN_NAME_LENGTH = 3;

/**
 * R8 cap 0.9 differed from variant a in 10 of 10 artist ids and 10 of 10 brand ids.
 * 0.8 and 0.6 also differed, and 0.9 is the highest cap that clears that bar for two types.
 */
export const DEEP_CUTS_POPULARITY_MAX = 0.9;

/**
 * Bridge anchors. "A" ranks every slot by shared tags. "B" keeps the best listen and wear,
 * and adds watch only when it shares at least WATCH_ANCHOR_MIN_SHARED tags.
 * Mean shared tags on the Bridge card (listen / wear): roots-gt-la A 18/3 vs B 18/4,
 * latin-tour-houston A 1/19 vs B 3/66. Both kept watch, listen, and wear, and A≠B held.
 * fandom-con-nyc returned no Bridge cards before the 24-call cap, so it does not pass.
 * (Pass 3d replaced its seeds and gave the place slot a second category set, so the
 * Bridge now fills; the measurement above is left as it was taken.)
 * Two presets pass, so the default is B.
 */
export const BRIDGE_ANCHOR_RULE: "A" | "B" = "B";
export const WATCH_ANCHOR_MIN_SHARED = 5;

export const PLACE_POINTS = {
  "Los Angeles": { lat: 34.0522, lon: -118.2437 },
  Houston: { lat: 29.7604, lon: -95.3698 },
  "New York": { lat: 40.7128, lon: -74.006 },
} as const;

export type PlaceCity = keyof typeof PLACE_POINTS;

export type PinnedSeed = {
  rawText: string;
  type: string;
  entityId: string | null;
  resolvedName: string | null;
};

export type PinnedPreset = {
  id: "roots-gt-la" | "latin-tour-houston" | "fandom-con-nyc";
  needsReview: boolean;
  city: "Los Angeles" | "Houston" | "New York";
  eventKind: "comunidad" | "tour" | "con";
  seeds: readonly PinnedSeed[];
};

export const PINNED_PRESETS: readonly PinnedPreset[] = [
  {
    id: "roots-gt-la",
    needsReview: false,
    city: "Los Angeles",
    eventKind: "comunidad",
    seeds: [
      {
        rawText: "Ricardo Arjona",
        type: "urn:entity:artist",
        entityId: "CA98034C-6AD8-44AA-898E-038495C4E116",
        resolvedName: "Ricardo Arjona",
      },
      {
        rawText: "Pollo Campero",
        type: "urn:entity:brand",
        entityId: "A5332654-C9F6-43B6-9A00-D0AE2BF8B20C",
        resolvedName: "Pollo Campero",
      },
      {
        rawText: "Gaby Moreno",
        type: "urn:entity:artist",
        entityId: "27B180A1-3E0A-4340-81A3-57FB51816E2D",
        resolvedName: "Gaby Moreno",
      },
    ],
  },
  {
    id: "latin-tour-houston",
    needsReview: false,
    city: "Houston",
    eventKind: "tour",
    seeds: [
      {
        rawText: "Bad Bunny",
        type: "urn:entity:artist",
        entityId: "BDA1B73F-10E7-4D09-AC51-B796CCEC5FF3",
        resolvedName: "Bad Bunny",
      },
      {
        rawText: "Karol G",
        type: "urn:entity:artist",
        entityId: "658495BB-DF77-472E-A6B2-9E37FF248FB3",
        resolvedName: "Karol G",
      },
      {
        rawText: "Nike",
        type: "urn:entity:brand",
        entityId: "C70CE2B8-0AD1-4150-BF18-5A6347F2E860",
        resolvedName: "Nike",
      },
    ],
  },
  {
    id: "fandom-con-nyc",
    needsReview: false,
    city: "New York",
    eventKind: "con",
    seeds: [
      {
        rawText: "Jujutsu Kaisen",
        type: "urn:entity:tv_show",
        entityId: "9328463A-D757-43FE-A7DA-FB2DB77F0B43",
        resolvedName: "Jujutsu Kaisen",
      },
      {
        rawText: "YOASOBI",
        type: "urn:entity:artist",
        entityId: "6D530441-36D4-436B-BE9B-0B07727A30C4",
        resolvedName: "yoasobi",
      },
      {
        rawText: "Crunchyroll",
        type: "urn:entity:brand",
        entityId: "FCB213DE-EF8F-4998-8B15-D820DEE34461",
        resolvedName: "Crunchyroll",
      },
    ],
  },
];

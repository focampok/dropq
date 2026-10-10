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

/** R7 live-night with anchors was 40% lodging in Los Angeles, Houston, and New York. */
export const PLACE_USE_ANCHORS = false;

/** Same keywords used to count lodging in R7. Last filter on the do slot. */
export const DO_EXCLUDE_TAG_KEYWORDS = ["hotel", "lodging", "resort", "motel", "inn", "suites"] as const;

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
        rawText: "Chainsaw Man",
        type: "urn:entity:tv_show",
        entityId: "042EB535-51B0-4DCF-8B33-1A3466952A56",
        resolvedName: "Chainsaw Man",
      },
      {
        rawText: "Kenshi Yonezu",
        type: "urn:entity:artist",
        entityId: "59992D0D-01F0-40EB-B587-05DC21051175",
        resolvedName: "Yonezu Kenshi",
      },
      {
        rawText: "Uniqlo",
        type: "urn:entity:brand",
        entityId: "46C9F889-EC89-4715-A767-DEABACF52C41",
        resolvedName: "Uniqlo",
      },
    ],
  },
];

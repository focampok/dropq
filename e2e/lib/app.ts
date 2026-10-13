/**
 * The app's own vocabulary, imported at test build time so an assertion can never drift
 * from the code it is checking. `tsx` resolves the `@/` paths these modules use.
 */
import { en } from "../../src/lib/i18n/en";
import { es } from "../../src/lib/i18n/es";
import { CITY_OPTIONS, type CityValue, type EventKind } from "../../src/lib/presets";
import type { Locale } from "../../src/lib/i18n";

export {
  WEAR_EXCLUDE_TAG_KEYWORDS,
  DO_EXCLUDE_TAG_KEYWORDS,
  PLACE_LODGING_TAG_WINDOW,
  PLACE_POINTS,
  PINNED_PRESETS,
  BRIDGE_ANCHOR_RULE,
  CONFIDENCE_SHARED_HIGH_MIN,
  CONFIDENCE_SHARED_MEDIUM_MIN,
  confidenceForSharedTags,
  type PlaceCity,
} from "../../src/lib/pipeline/config";
export {
  normalizeForMatch,
  normalizeSeedNames,
  isSeedFamilyName,
  wearTagsExcluded,
  dedupeTags,
} from "../../src/lib/pipeline/tags";
export { CITY_VALUES, CITY_OPTIONS, DEMO_PRESETS, presetSeedTexts, type CityValue, type EventKind } from "../../src/lib/presets";
export { STEP_IDS } from "../../src/lib/i18n/types";
export { en } from "../../src/lib/i18n/en";
export { es } from "../../src/lib/i18n/es";

/** Narrative limits enforced by the app's validator (src/lib/pipeline/llm.ts). */
export const MAX_NARRATIVE_SENTENCES = 2;
export const MAX_NARRATIVE_CHARS = 280;
/** Display cap before the "+N more" control (src/lib/pipeline/tags.ts). */
export const TAG_PREVIEW_LIMIT = 8;

/** Preset seed display names, per preset id (rawText is what the form types). */
export const PRESET_SEEDS: Record<string, string[]> = {
  "roots-gt-la": ["Ricardo Arjona", "Pollo Campero", "Gaby Moreno"],
  "latin-tour-houston": ["Bad Bunny", "Karol G", "Nike"],
  "fandom-con-nyc": ["Jujutsu Kaisen", "YOASOBI", "Crunchyroll"],
};

export function dict(locale: Locale) {
  return locale === "es" ? es : en;
}

export function presetLabel(locale: Locale, presetId: string): string {
  return dict(locale).presets[presetId as keyof typeof en.presets];
}

const CITY_ID_OF: Record<CityValue, string> = {
  "Los Angeles": "los-angeles",
  Houston: "houston",
  "New York": "new-york",
  "Ciudad de México": "cdmx",
  Guatemala: "guatemala",
};

export function cityLabel(locale: Locale, city: CityValue): string {
  return dict(locale).cities[CITY_ID_OF[city] as keyof typeof en.cities];
}

export function kindLabel(locale: Locale, kind: EventKind): string {
  return dict(locale).eventKinds[kind];
}

export function cityIds(): string[] {
  return CITY_OPTIONS.map((option) => option.id);
}

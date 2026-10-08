export const CITY_VALUES = [
  "Los Angeles",
  "Houston",
  "New York",
  "Ciudad de México",
  "Guatemala",
] as const;

export type CityValue = (typeof CITY_VALUES)[number];

export const CITY_OPTIONS = [
  { id: "los-angeles", value: "Los Angeles" },
  { id: "houston", value: "Houston" },
  { id: "new-york", value: "New York" },
  { id: "cdmx", value: "Ciudad de México" },
  { id: "guatemala", value: "Guatemala" },
] as const;

export type CityId = (typeof CITY_OPTIONS)[number]["id"];

export const EVENT_KINDS = ["tour", "con", "comunidad"] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export const DEMO_PRESETS = [
  {
    id: "roots-gt-la",
    seeds: [
      { rawText: "Ricardo Arjona", type: "urn:entity:artist" },
      { rawText: "Pollo Campero", type: "urn:entity:brand" },
      { rawText: "Gaby Moreno", type: "urn:entity:artist" },
    ],
    city: "Los Angeles",
    eventKind: "comunidad",
  },
  {
    id: "latin-tour-houston",
    seeds: [
      { rawText: "Bad Bunny", type: "urn:entity:artist" },
      { rawText: "Karol G", type: "urn:entity:artist" },
      { rawText: "Nike", type: "urn:entity:brand" },
    ],
    city: "Houston",
    eventKind: "tour",
  },
  {
    id: "fandom-con-nyc",
    seeds: [
      { rawText: "Chainsaw Man", type: "urn:entity:tv_show" },
      { rawText: "Kenshi Yonezu", type: "urn:entity:artist" },
      { rawText: "Uniqlo", type: "urn:entity:brand" },
    ],
    city: "New York",
    eventKind: "con",
  },
] as const;

export type PresetId = (typeof DEMO_PRESETS)[number]["id"];

export function presetSeedTexts(
  preset: (typeof DEMO_PRESETS)[number],
): readonly string[] {
  return preset.seeds.map((seed) => seed.rawText);
}

export function matchesPresetSeeds(texts: readonly string[]): boolean {
  return DEMO_PRESETS.some((preset) => {
    const seeds = presetSeedTexts(preset);
    return texts.length === seeds.length && seeds.every((seed, index) => seed === texts[index]);
  });
}

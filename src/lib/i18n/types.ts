import type { CityId, EventKind, PresetId } from "@/lib/presets";

export const STEP_IDS = [
  "resolve_seeds",
  "insights_hop0",
  "pick_bridge_anchors",
  "insights_hop1",
  "assemble",
  "enrich",
  "done",
] as const;

export type StepId = (typeof STEP_IDS)[number];

export type SlotName = "watch" | "listen" | "wear" | "do";

export type Dictionary = {
  meta: { title: string; description: string };
  brand: string;
  tagline: string;
  subline: string;
  language: { label: string; en: string; es: string };
  onboarding: {
    presets: string;
    city: string;
    eventKind: string;
    anchors: string;
    anchorsHint: string;
    anchorLabel: string;
    anchorPlaceholder: string;
    addAnchor: string;
    removeAnchor: string;
    packNight: string;
    saving: string;
    saveError: string;
    needAnchors: string;
  };
  cities: Record<CityId, string>;
  eventKinds: Record<EventKind, string>;
  presets: Record<PresetId, string>;
  slots: Record<SlotName, string>;
  plans: { A: string; B: string };
  pack: {
    mockBadge: string;
    whyQloo: string;
    name: string;
    type: string;
    entityId: string;
    hop: string;
    affinity: string;
    noAffinity: string;
    confidence: string;
    noImage: string;
    pending: string;
    active: string;
    stepDone: string;
    stepSkipped: string;
    coverage: string;
    quotaLow: string;
    timeout: string;
    noAnchors: string;
    resolvedAs: string;
    hitTags: string;
    sharedTags: string;
    explainability: string;
    narrativeEmpty: string;
    narrativeTemplate: string;
    chosenForCity: string;
    deepCuts: string;
    deepCutsOn: string;
    deepCutsOff: string;
    steps: Record<StepId, string>;
    confidenceValue: {
      high: string;
      medium: string;
      low: string;
      unverified: string;
    };
  };
};

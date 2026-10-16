import type { BaselinePayload } from "@/lib/baseline/types";
import type { SlotName } from "@/lib/i18n/types";

export type BriefAnchor = {
  rawText: string;
  resolvedName: string | null;
  type: string;
  entityId: string | null;
  unverified: boolean;
};

export type BriefItem = {
  slot: SlotName;
  name: string;
  entityId: string;
  type: string;
  hop: number;
  explain: string;
  evidenceLine: string;
  confidence: "high" | "medium" | "low" | "unverified";
  chosenForCity: boolean;
};

export type BriefPlan = {
  label: "A" | "B";
  axis: string;
  narrative: string | null;
  headline: string;
  narrationSource: "llm" | "template";
  items: BriefItem[];
};

export type BriefPayload = {
  packId: string;
  sessionId: string;
  locale: "en" | "es";
  city: string;
  eventKind: string;
  generatedAt: string;
  isPreset: boolean;
  anchors: BriefAnchor[];
  plans: BriefPlan[];
  coverageNote: string;
  baseline: BaselinePayload | null;
};

/** Test counters: brief building must never spend Qloo/Gemini or write rows. */
export type BriefBuildCounters = {
  qlooBefore: number;
  geminiBefore: number;
  qlooAfter: number;
  geminiAfter: number;
  writes: number;
};

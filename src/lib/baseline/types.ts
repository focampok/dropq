export type BaselineSlot = "watch" | "listen" | "wear" | "do";

export type BaselineLlmItem = {
  slot: BaselineSlot;
  name: string;
};

export type BaselineVerifyStatus = "verified" | "not_verifiable";

export type BaselineVerification = {
  slot: BaselineSlot;
  status: BaselineVerifyStatus;
  resolvedEntityId: string | null;
  resolvedName: string | null;
  inPack: boolean;
  reason?: "no_match" | "search_error" | "empty_name";
};

export type BaselineSource = "llm" | "template";

export type BaselinePayload = {
  cardsSig: string;
  locale: "en" | "es";
  llmItems: BaselineLlmItem[];
  verification: BaselineVerification[];
  source: BaselineSource;
  summary: { verified: number; inPack: number };
};

export const BASELINE_SLOTS: BaselineSlot[] = ["watch", "listen", "wear", "do"];

export const SLOT_ENTITY_TYPE: Record<BaselineSlot, string> = {
  watch: "urn:entity:tv_show",
  listen: "urn:entity:artist",
  wear: "urn:entity:brand",
  do: "urn:entity:place",
};

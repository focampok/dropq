import { composeBaselineItems } from "@/lib/baseline/compose";
import { verifyBaselineItems } from "@/lib/baseline/resolve";
import { summarize } from "@/lib/baseline/validate";
import type { BaselinePayload, BaselineSlot } from "@/lib/baseline/types";

/**
 * Live baseline: one LLM call, then ≤4 typed searches. Never fabricates when the LLM
 * is unavailable — callers map `unavailable` to HTTP 503.
 */
export async function buildBaseline(input: {
  cardsSig: string;
  locale: "en" | "es";
  city: string;
  eventKind: string;
  anchors: string[];
  packIdsBySlot: Partial<Record<BaselineSlot, Set<string>>>;
}): Promise<
  | { ok: true; payload: BaselinePayload; qlooCalls: number }
  | { ok: false; reason: "unavailable" | "quota" | "llm_error" }
> {
  const composed = await composeBaselineItems({
    locale: input.locale,
    city: input.city,
    eventKind: input.eventKind,
    anchors: input.anchors,
  });
  if (!composed.ok) return { ok: false, reason: composed.reason };

  const { verification, qlooCalls } = await verifyBaselineItems(composed.items, input.packIdsBySlot);
  const summary = summarize(verification);
  return {
    ok: true,
    qlooCalls,
    payload: {
      cardsSig: input.cardsSig,
      locale: input.locale,
      llmItems: composed.items,
      verification,
      source: composed.source,
      summary,
    },
  };
}

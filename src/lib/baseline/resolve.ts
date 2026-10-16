import { observedQlooCalls, search } from "@/lib/qloo/client";
import {
  BASELINE_SLOTS,
  SLOT_ENTITY_TYPE,
  type BaselineLlmItem,
  type BaselineSlot,
  type BaselineVerification,
} from "@/lib/baseline/types";

/**
 * Resolve each LLM-only name with one typed `/search`. At most four Qloo calls.
 * A failed or empty search is `not_verifiable`, never a throw.
 */
export async function verifyBaselineItems(
  items: BaselineLlmItem[],
  packIdsBySlot: Partial<Record<BaselineSlot, Set<string>>>,
): Promise<{ verification: BaselineVerification[]; qlooCalls: number }> {
  const before = observedQlooCalls();
  const verification: BaselineVerification[] = [];
  for (const slot of BASELINE_SLOTS) {
    const item = items.find((entry) => entry.slot === slot);
    const name = item?.name?.trim() ?? "";
    if (!name) {
      verification.push({
        slot,
        status: "not_verifiable",
        resolvedEntityId: null,
        resolvedName: null,
        inPack: false,
        reason: "empty_name",
      });
      continue;
    }
    try {
      const found = await search({ query: name, type: SLOT_ENTITY_TYPE[slot] });
      const top = found.results[0];
      if (!top?.entityId?.trim()) {
        verification.push({
          slot,
          status: "not_verifiable",
          resolvedEntityId: null,
          resolvedName: null,
          inPack: false,
          reason: "no_match",
        });
        continue;
      }
      const id = top.entityId.trim().toUpperCase();
      verification.push({
        slot,
        status: "verified",
        resolvedEntityId: top.entityId,
        resolvedName: top.name,
        inPack: Boolean(packIdsBySlot[slot]?.has(id)),
      });
    } catch {
      verification.push({
        slot,
        status: "not_verifiable",
        resolvedEntityId: null,
        resolvedName: null,
        inPack: false,
        reason: "search_error",
      });
    }
  }
  return {
    verification,
    qlooCalls: Math.max(0, observedQlooCalls() - before),
  };
}

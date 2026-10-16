import {
  BASELINE_SLOTS,
  type BaselinePayload,
  type BaselineSlot,
  type BaselineVerification,
} from "@/lib/baseline/types";

export type BaselineValidationResult =
  | { ok: true }
  | { ok: false; rule: string; detail?: string };

/** Four items, one per slot, statuses valid, inPack consistent with the pack entity ids. */
export function validateBaseline(
  payload: BaselinePayload,
  packEntityIdsBySlot?: Partial<Record<BaselineSlot, Set<string>>>,
): BaselineValidationResult {
  if (!payload.llmItems || payload.llmItems.length !== 4) {
    return { ok: false, rule: "item_count", detail: String(payload.llmItems?.length ?? 0) };
  }
  if (!payload.verification || payload.verification.length !== 4) {
    return { ok: false, rule: "verification_count" };
  }
  if (payload.source !== "llm" && payload.source !== "template") {
    return { ok: false, rule: "source" };
  }
  const seen = new Set<string>();
  for (const item of payload.llmItems) {
    if (!BASELINE_SLOTS.includes(item.slot)) return { ok: false, rule: "bad_slot", detail: item.slot };
    if (seen.has(item.slot)) return { ok: false, rule: "duplicate_slot", detail: item.slot };
    seen.add(item.slot);
    if (!item.name?.trim()) return { ok: false, rule: "empty_name", detail: item.slot };
  }
  if (seen.size !== 4) return { ok: false, rule: "missing_slot" };

  for (const row of payload.verification) {
    if (!BASELINE_SLOTS.includes(row.slot)) return { ok: false, rule: "bad_verify_slot" };
    if (row.status !== "verified" && row.status !== "not_verifiable") {
      return { ok: false, rule: "bad_status", detail: row.slot };
    }
    if (row.status === "verified" && !row.resolvedEntityId?.trim()) {
      return { ok: false, rule: "verified_without_id", detail: row.slot };
    }
    if (packEntityIdsBySlot) {
      const expected = Boolean(
        row.resolvedEntityId &&
          packEntityIdsBySlot[row.slot]?.has(row.resolvedEntityId.trim().toUpperCase()),
      );
      if (row.inPack !== expected) {
        return { ok: false, rule: "in_pack_mismatch", detail: row.slot };
      }
    }
  }
  const verified = payload.verification.filter((row) => row.status === "verified").length;
  const inPack = payload.verification.filter((row) => row.inPack).length;
  if (payload.summary.verified !== verified || payload.summary.inPack !== inPack) {
    return { ok: false, rule: "summary_mismatch" };
  }
  return { ok: true };
}

export function packEntityIdsBySlot(
  packs: { label: string; items: { slot: string; qlooEntityId: string }[] }[],
): Partial<Record<BaselineSlot, Set<string>>> {
  const out: Partial<Record<BaselineSlot, Set<string>>> = {};
  for (const plan of packs) {
    for (const item of plan.items) {
      const slot = item.slot as BaselineSlot;
      if (!BASELINE_SLOTS.includes(slot)) continue;
      const set = out[slot] ?? new Set<string>();
      set.add(item.qlooEntityId.trim().toUpperCase());
      out[slot] = set;
    }
  }
  return out;
}

export function summarize(verification: BaselineVerification[]): { verified: number; inPack: number } {
  return {
    verified: verification.filter((row) => row.status === "verified").length,
    inPack: verification.filter((row) => row.inPack).length,
  };
}

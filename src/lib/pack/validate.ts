/**
 * Pack invariants shared by the browser suite (A2/A3), warm, and preset cache writes.
 * A violating pack must never be stored as a preset row.
 */
import {
  DO_EXCLUDE_TAG_KEYWORDS,
  PLACE_LODGING_TAG_WINDOW,
} from "@/lib/pipeline/config";
import { isSeedFamilyName, normalizeSeedNames, wearTagsExcluded } from "@/lib/pipeline/tags";
import type { PackCachePayload } from "@/lib/pack/cache";

export type PackValidationRule =
  | "missing_plan"
  | "missing_slot"
  | "missing_entity_id"
  | "plans_overlap"
  | "watch_not_tv"
  | "do_lodging"
  | "wear_seed_family"
  | "wear_non_wearable"
  | "duplicate_shared_tags"
  | "narration_tokens";

export type PackValidationResult =
  | { ok: true }
  | { ok: false; rule: PackValidationRule; detail?: string };

const SLOTS = ["watch", "listen", "wear", "do"] as const;
const TOKEN_RE = /\[\[([a-z0-9]+)\]\]/gi;

function hitTags(evidence: unknown): string[] {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return [];
  const tags = (evidence as { hitTags?: unknown }).hitTags;
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is string => typeof tag === "string");
}

function sharedTags(evidence: unknown): string[] {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return [];
  const tags = (evidence as { sharedTags?: unknown }).sharedTags;
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is string => typeof tag === "string");
}

function looksLikeLodging(name: string, tags: readonly string[]): boolean {
  const window = tags.slice(0, PLACE_LODGING_TAG_WINDOW);
  const haystack = `${name} ${window.join(" ")}`.toLowerCase();
  return DO_EXCLUDE_TAG_KEYWORDS.some((word) => haystack.includes(word));
}

function unresolvedTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    found.push(match[0]!);
  }
  return found;
}

/**
 * Pure check of a stored/snapshot pack. Seed names come from the payload so the
 * seed-family rule matches what the pipeline used when the row was built.
 */
export function validatePack(pack: PackCachePayload): PackValidationResult {
  const plans = pack.packs ?? [];
  const planA = plans.find((entry) => entry.label === "A");
  const planB = plans.find((entry) => entry.label === "B");
  if (!planA || !planB) return { ok: false, rule: "missing_plan" };

  const seedNames = normalizeSeedNames(
    pack.seeds.map((seed) => seed.resolvedName?.trim() || seed.rawText),
  );
  const idsA = new Set<string>();
  const idsB = new Set<string>();

  for (const plan of [planA, planB]) {
    const bySlot = new Map(plan.items.map((item) => [item.slot, item]));
    for (const slot of SLOTS) {
      const item = bySlot.get(slot);
      if (!item) return { ok: false, rule: "missing_slot", detail: `${plan.label}:${slot}` };
      const id = item.qlooEntityId?.trim() ?? "";
      if (!id) return { ok: false, rule: "missing_entity_id", detail: `${plan.label}:${slot}` };
      (plan.label === "A" ? idsA : idsB).add(id.toUpperCase());

      if (slot === "watch") {
        const type = item.qlooType?.toLowerCase() ?? "";
        if (!type.endsWith(":tv_show")) {
          return { ok: false, rule: "watch_not_tv", detail: item.qlooName };
        }
      }
      if (slot === "do") {
        const tags = hitTags(item.evidence);
        if (looksLikeLodging(item.qlooName, tags)) {
          return { ok: false, rule: "do_lodging", detail: item.qlooName };
        }
      }
      if (slot === "wear") {
        if (isSeedFamilyName(item.qlooName, seedNames)) {
          return { ok: false, rule: "wear_seed_family", detail: item.qlooName };
        }
        const tags = hitTags(item.evidence);
        // Unknown tags are not wearable on faith — same fail-closed rule as the filter.
        if (tags.length === 0 || wearTagsExcluded(tags)) {
          return { ok: false, rule: "wear_non_wearable", detail: item.qlooName };
        }
      }

      // Same distinctness rule as browser B1: trim + case fold, not accent folding.
      const shared = sharedTags(item.evidence);
      const seen = new Set<string>();
      for (const tag of shared) {
        const key = tag.trim().toLowerCase();
        if (!key) continue;
        if (seen.has(key)) {
          return { ok: false, rule: "duplicate_shared_tags", detail: tag };
        }
        seen.add(key);
      }
    }

    const unresolved = unresolvedTokens(plan.narrative);
    if (unresolved.length > 0) {
      return { ok: false, rule: "narration_tokens", detail: unresolved[0] };
    }
  }

  for (const id of idsA) {
    if (idsB.has(id)) return { ok: false, rule: "plans_overlap", detail: id };
  }
  return { ok: true };
}

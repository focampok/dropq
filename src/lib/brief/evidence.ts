import { getDictionary, type Locale } from "@/lib/i18n";
import type { SlotName } from "@/lib/i18n/types";

/** Compact "why this fits" line from stored evidence — no new Qloo calls. */
export function evidenceLineFromStored(
  evidence: Record<string, unknown> | null | undefined,
  locale: Locale,
): string {
  const dictionary = getDictionary(locale);
  if (!evidence) return "";
  if (evidence.chosenByCity === true) return dictionary.pack.chosenForCityEvidence;

  const shared = asStringList(evidence.sharedTags);
  if (shared.length > 0) {
    return `${dictionary.pack.sharedTags}: ${shared.join(", ")}`;
  }

  const anchor = evidence.anchor;
  if (anchor && typeof anchor === "object") {
    const tags = asStringList((anchor as { sharedTags?: unknown }).sharedTags);
    if (tags.length > 0) {
      return `${dictionary.pack.anchorEvidence}: ${tags.join(", ")}`;
    }
  }

  const hit = asStringList(evidence.hitTags);
  if (hit.length > 0) {
    return `${dictionary.pack.hitTags}: ${hit.slice(0, 6).join(", ")}`;
  }

  const explainability = evidence.explainability;
  if (typeof explainability === "string" && explainability.trim()) {
    return `${dictionary.pack.explainability}: ${explainability.trim()}`;
  }

  return "";
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

export function isSlotName(value: string): value is SlotName {
  return value === "watch" || value === "listen" || value === "wear" || value === "do";
}

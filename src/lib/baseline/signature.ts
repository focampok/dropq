import { createHash } from "node:crypto";
import { packCardsSignature } from "@/lib/pack/cache";

/** Cache key for one language's baseline of a pack identity. */
export function baselineSignature(input: {
  entityIds: string[];
  city: string;
  eventKind: string;
  locale: string;
  mode?: "default" | "deep_cuts";
}): { cardsSig: string; signature: string } {
  const cardsSig = packCardsSignature({
    entityIds: input.entityIds,
    city: input.city,
    eventKind: input.eventKind,
    mode: input.mode ?? "default",
  });
  const locale = input.locale === "es" ? "es" : "en";
  const signature = createHash("sha256")
    .update(JSON.stringify({ cardsSig, locale, kind: "baseline" }))
    .digest("hex");
  return { cardsSig, signature };
}

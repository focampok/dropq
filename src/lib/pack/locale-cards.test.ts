import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginPackFlight,
  cloneCardsForLocale,
  packCardsSignature,
  resetPackSingleFlight,
  type PackCachePayload,
} from "@/lib/pack/cache";
import { validateCrossLanguageParity } from "@/lib/pack/validate";

function item(
  slot: "watch" | "listen" | "wear" | "do",
  id: string,
): PackCachePayload["packs"][number]["items"][number] {
  const meta = {
    watch: { name: "Show", type: "urn:entity:tv_show", tags: ["Drama"] },
    listen: { name: "Artist", type: "urn:entity:artist", tags: ["Pop"] },
    wear: { name: "Puma", type: "urn:entity:brand", tags: ["Apparel"] },
    do: { name: "Venue", type: "urn:entity:place", tags: ["Nightlife"] },
  }[slot];
  return {
    slot,
    position: 0,
    hop: slot === "watch" || slot === "listen" ? 0 : 1,
    qlooEntityId: id,
    qlooName: meta.name,
    qlooType: meta.type,
    imageUrl: null,
    affinityScore: null,
    explain: null,
    evidence: { hitTags: meta.tags, sharedTags: [] },
    confidence: "medium",
    provenance: "qloo",
  };
}

function payload(locale: "en" | "es"): PackCachePayload {
  const items = (prefix: string) =>
    (["watch", "listen", "wear", "do"] as const).map((slot) => item(slot, `${prefix}-${slot}`));
  return {
    city: "Houston",
    eventKind: "tour",
    locale,
    seeds: [
      { rawText: "Bad Bunny", source: "preset", resolvedEntityId: "s1", resolvedName: "Bad Bunny", domain: "artist" },
      { rawText: "Karol G", source: "preset", resolvedEntityId: "s2", resolvedName: "Karol G", domain: "artist" },
      { rawText: "Nike", source: "preset", resolvedEntityId: "s3", resolvedName: "Nike", domain: "brand" },
    ],
    packs: [
      {
        label: "A",
        axis: "root",
        narrative: locale === "en" ? "Tonight with Artist." : "Esta noche con Artist.",
        coverage: { llm: { narrative: "llm", anchorSource: "llm" } },
        items: items("a"),
      },
      {
        label: "B",
        axis: "bridge",
        narrative: locale === "en" ? "Bridge with Puma." : "Puente con Puma.",
        coverage: { llm: { narrative: "llm", anchorSource: "llm" } },
        items: items("b"),
      },
    ],
  };
}

describe("language-neutral cards", () => {
  beforeEach(() => resetPackSingleFlight());
  afterEach(() => resetPackSingleFlight());

  it("cloning for the other language keeps every entity id (custom or preset)", () => {
    const en = payload("en");
    const es = cloneCardsForLocale(en, "es");
    es.packs[0]!.narrative = "Esta noche con Artist.";
    es.packs[1]!.narrative = "Puente con Puma.";
    expect(validateCrossLanguageParity(en, es)).toEqual({ ok: true });
    // Narration-only path never needs a new Qloo round: qlooCalls stay at zero by construction.
    expect(es.packs.flatMap((pack) => pack.items.map((item) => item.qlooEntityId))).toEqual(
      en.packs.flatMap((pack) => pack.items.map((item) => item.qlooEntityId)),
    );
  });

  it("single-flights concurrent first builds on the cards signature", async () => {
    const cardsSig = packCardsSignature({
      entityIds: ["s1", "s2", "s3"],
      city: "Houston",
      eventKind: "tour",
    });
    let builds = 0;
    const build = async () => {
      builds += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { payload: payload("en"), builtAt: new Date() };
    };
    const en = beginPackFlight(cardsSig, "session-en", build);
    const es = beginPackFlight(cardsSig, "session-es", build);
    expect(en.owner).toBe(true);
    expect(es.owner).toBe(false);
    const [a, b] = await Promise.all([en.promise, es.promise]);
    expect(builds).toBe(1);
    expect(a.payload.packs[1]!.items[2]!.qlooEntityId).toBe(b.payload.packs[1]!.items[2]!.qlooEntityId);
  });

  it("parity rejects when a concurrent build would have diverged", () => {
    const en = payload("en");
    const es = cloneCardsForLocale(en, "es");
    es.packs[1]!.items[2] = item("wear", "diverged-wear");
    expect(validateCrossLanguageParity(en, es).ok).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { PackCachePayload } from "@/lib/pack/cache";
import { validatePack } from "@/lib/pack/validate";

function item(
  slot: "watch" | "listen" | "wear" | "do",
  overrides: Partial<PackCachePayload["packs"][number]["items"][number]> = {},
): PackCachePayload["packs"][number]["items"][number] {
  const defaults = {
    watch: { name: "Show", type: "urn:entity:tv_show", tags: ["Drama"] },
    listen: { name: "Artist", type: "urn:entity:artist", tags: ["Pop"] },
    wear: { name: "Puma", type: "urn:entity:brand", tags: ["Apparel"] },
    do: { name: "Venue", type: "urn:entity:place", tags: ["Nightlife"] },
  }[slot];
  return {
    slot,
    position: 0,
    hop: 0,
    qlooEntityId: overrides.qlooEntityId ?? `${slot}-id`,
    qlooName: overrides.qlooName ?? defaults.name,
    qlooType: overrides.qlooType ?? defaults.type,
    imageUrl: null,
    affinityScore: null,
    explain: null,
    evidence: overrides.evidence ?? { hitTags: defaults.tags, sharedTags: [] },
    confidence: "medium",
    provenance: "qloo",
    ...overrides,
  };
}

function pack(overrides?: {
  wearA?: Partial<PackCachePayload["packs"][number]["items"][number]>;
  wearB?: Partial<PackCachePayload["packs"][number]["items"][number]>;
  narrativeA?: string | null;
}): PackCachePayload {
  return {
    city: "Houston",
    eventKind: "tour",
    locale: "en",
    seeds: [
      { rawText: "Bad Bunny", source: "preset", resolvedEntityId: "s1", resolvedName: "Bad Bunny", domain: "artist" },
      { rawText: "Karol G", source: "preset", resolvedEntityId: "s2", resolvedName: "Karol G", domain: "artist" },
      { rawText: "Nike", source: "preset", resolvedEntityId: "s3", resolvedName: "Nike", domain: "brand" },
    ],
    packs: [
      {
        label: "A",
        axis: "root",
        narrative: overrides?.narrativeA ?? "Tonight with Artist.",
        coverage: {},
        items: [
          item("watch", { qlooEntityId: "a-watch" }),
          item("listen", { qlooEntityId: "a-listen" }),
          item("wear", { qlooEntityId: "a-wear", ...overrides?.wearA }),
          item("do", { qlooEntityId: "a-do" }),
        ],
      },
      {
        label: "B",
        axis: "bridge",
        narrative: "Bridge with Puma.",
        coverage: {},
        items: [
          item("watch", { qlooEntityId: "b-watch" }),
          item("listen", { qlooEntityId: "b-listen" }),
          item("wear", { qlooEntityId: "b-wear", ...overrides?.wearB }),
          item("do", { qlooEntityId: "b-do" }),
        ],
      },
    ],
  };
}

describe("validatePack", () => {
  it("accepts a well-formed pack", () => {
    expect(validatePack(pack())).toEqual({ ok: true });
  });

  it("rejects ice-cream in wear and unknown wear tags", () => {
    const dessert = validatePack(
      pack({
        wearB: {
          qlooName: "Häagen-Dazs",
          evidence: { hitTags: ["Ice Cream", "Dessert"], sharedTags: [] },
        },
      }),
    );
    expect(dessert).toEqual({ ok: false, rule: "wear_non_wearable", detail: "Häagen-Dazs" });

    const unknown = validatePack(
      pack({
        wearA: { qlooName: "Mystery", evidence: { hitTags: [], sharedTags: [] } },
      }),
    );
    expect(unknown).toEqual({ ok: false, rule: "wear_non_wearable", detail: "Mystery" });
  });

  it("rejects overlapping plans and lodging in do", () => {
    const overlap = pack();
    overlap.packs[1]!.items[0] = item("watch", { qlooEntityId: "a-watch" });
    expect(validatePack(overlap).ok).toBe(false);
    expect(validatePack(overlap)).toMatchObject({ rule: "plans_overlap" });

    const lodging = pack();
    lodging.packs[0]!.items[3] = item("do", {
      qlooEntityId: "hotel-1",
      qlooName: "Grand Hotel",
      evidence: { hitTags: ["Hotel", "Lodging"], sharedTags: [] },
    });
    expect(validatePack(lodging)).toMatchObject({ rule: "do_lodging" });
  });

  it("rejects unresolved narration tokens", () => {
    expect(validatePack(pack({ narrativeA: "Tonight [[listen]] and [[missing]]." }))).toMatchObject({
      rule: "narration_tokens",
    });
  });
});

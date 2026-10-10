import { describe, expect, it, vi } from "vitest";
import { anchorsForRule, deterministicAnchors, validAnchorIds } from "@/lib/pipeline/anchors";
import { substituteTokens, tokensIn, validateNarrative } from "@/lib/pipeline/llm";
import { DEMO_PRESETS } from "@/lib/presets";
import { BRIDGE_ANCHOR_RULE, PINNED_PRESETS, PLACE_RADIUS_FALLBACK_M } from "@/lib/pipeline/config";
import { packsToWrite } from "@/lib/pipeline/run";
import { insightArgs, loadPlaceHits, loadWatchHits, locationKey } from "@/lib/pipeline/requests";
import { assemblePack } from "@/lib/pack/assemble";
import { runIndependent } from "@/lib/pipeline/settle";

const candidates = [
  { id: "watch-1", name: "Film", slot: "watch" as const, tags: ["Drama"] },
  { id: "listen-1", name: "Artist", slot: "listen" as const, tags: ["Pop"] },
  { id: "wear-1", name: "Brand", slot: "wear" as const, tags: ["Cloth"] },
];

describe("pipeline decisions", () => {
  it("falls back to the top hit per slot when no candidate shares a tag with the seeds", () => {
    expect(deterministicAnchors(candidates)).toEqual(["listen-1", "wear-1", "watch-1"]);
  });

  it("keeps only the candidates that share a tag with the seeds", () => {
    const seedTags = new Set(["pop", "cloth"]);
    expect(deterministicAnchors(candidates, seedTags)).toEqual(["listen-1", "wear-1"]);

    const partial = new Set(["drama"]);
    expect(deterministicAnchors(candidates, partial)).toEqual(["listen-1", "wear-1", "watch-1"]);
  });

  it("ranks by stored sharedTagCount instead of the truncated tag list", () => {
    const seedTags = new Set(["pop", "drama"]);
    const truncated = ["a", "b", "c", "d", "e", "f", "g", "h"];
    expect(
      deterministicAnchors(
        [
          { id: "listen-high", name: "L", slot: "listen", tags: truncated, sharedTagCount: 12 },
          { id: "wear-low", name: "W", slot: "wear", tags: ["Pop"], sharedTagCount: 1 },
          { id: "watch-trunc", name: "V", slot: "watch", tags: ["Drama"], sharedTagCount: 0 },
        ],
        seedTags,
      ),
    ).toEqual(["listen-high", "wear-low"]);
  });

  it("does not send filter.exclude.entities for place and widens take to 20", () => {
    const place = insightArgs({
      slot: "do",
      eventKind: "tour",
      anchors: [],
      city: "Houston",
      hop: 1,
      exclude: ["root-1", "root-2"],
    });
    expect(place?.filterExcludeEntities).toBeUndefined();
    expect(place?.take).toBe(20);

    const watch = insightArgs({
      slot: "watch",
      eventKind: "tour",
      anchors: ["anchor"],
      city: "Houston",
      hop: 1,
      exclude: ["root-1", "root-2"],
    });
    expect(watch?.filterExcludeEntities).toEqual(["root-1", "root-2"]);
    expect(watch?.take).toBe(10);
  });

  it("widens only the radius when the place retry asks for it", () => {
    const args = insightArgs({
      slot: "do",
      eventKind: "tour",
      anchors: [],
      city: "Houston",
      hop: 1,
      exclude: [],
      placeRadius: PLACE_RADIUS_FALLBACK_M,
    });
    expect(args?.filterLocationRadius).toBe(PLACE_RADIUS_FALLBACK_M);
  });

  it("falls back when the model returns an id that was not offered", async () => {
    vi.stubEnv("LLM_PROVIDER", "nebius");
    vi.stubEnv("NEBIUS_API_KEY", "test");
    vi.stubEnv("NEBIUS_BASE_URL", "https://example.test/v1");
    vi.stubEnv("NEBIUS_MODEL", "test-model");
    vi.doMock("ai", () => ({
      generateObject: vi.fn(async () => ({ object: { anchorIds: ["not-a-real-id", "watch-1"], reason: "" } })),
    }));
    vi.resetModules();
    const { pickBridgeAnchors: pick } = await import("@/lib/pipeline/llm");
    await expect(pick(candidates)).resolves.toEqual(anchorsForRule(candidates));
    vi.unstubAllEnvs();
    vi.doUnmock("ai");
    vi.resetModules();
  });

  it("replaces tokens with the pack's own names and rejects an unknown token", () => {
    const plan = {
      label: "A" as const,
      city: "New York",
      anchors: [{ name: "Chainsaw Man" }, { name: "Uniqlo" }],
      slots: { watch: "Hell's Paradise", listen: "Claris" },
    };
    expect(substituteTokens("[[city]]: [[watch]] + [[listen]]", plan)).toBe(
      "New York: Hell's Paradise + Claris",
    );
    expect(tokensIn("[[watch]] and [[nope]]")).toEqual(["watch", "nope"]);
    expect(validateNarrative("[[nope]] wins.", plan, "en", 280)).toBe("unknown_token");
    expect(validateNarrative("[[watch]] then [[watch]].", plan, "en", 280)).toBe("repeated_token");
    // A narrative that names nothing cannot be trusted to have named the cards.
    expect(validateNarrative("A night with no tokens.", plan, "en", 280)).toBe("no_token");
    expect(validateNarrative("A night with no tokens.", plan, "en", 60, false)).toBeNull();
  });

  it("passes Roots ids to hop 1 as filter.exclude.entities", () => {
    const args = insightArgs({
      slot: "watch",
      eventKind: "tour",
      anchors: ["bridge-1"],
      city: "Houston",
      hop: 1,
      exclude: ["root-1", "root-2"],
    });
    expect(args?.filterExcludeEntities).toEqual(["root-1", "root-2"]);
    expect(args?.signalLocationQuery).toBe("Houston");
  });

  it("keeps the other slots when the place call fails", async () => {
    const result = await runIndependent([
      { key: "watch", run: async () => "film" },
      { key: "do", run: async () => Promise.reject(new Error("timeout")) },
    ]);
    expect(result).toEqual([
      { key: "watch", value: "film" },
      { key: "do", value: null },
    ]);
  });
});

describe("round 3 quality", () => {
  it("uses Ricardo Arjona, Pollo Campero, and Gaby Moreno for Roots GT", () => {
    const demo = DEMO_PRESETS.find((preset) => preset.id === "roots-gt-la");
    const pinned = PINNED_PRESETS.find((preset) => preset.id === "roots-gt-la");
    expect(demo?.seeds.map((seed) => seed.rawText)).toEqual([
      "Ricardo Arjona",
      "Pollo Campero",
      "Gaby Moreno",
    ]);
    expect(demo?.seeds.map((seed) => seed.type)).toEqual([
      "urn:entity:artist",
      "urn:entity:brand",
      "urn:entity:artist",
    ]);
    expect(pinned?.needsReview).toBe(false);
    expect(pinned?.seeds[2]?.entityId).toBe("27B180A1-3E0A-4340-81A3-57FB51816E2D");
    expect(pinned?.seeds.some((seed) => seed.rawText === "Gallo")).toBe(false);
  });

  it("keeps the demo and pinned fandom seeds identical and resolvable", () => {
    const demo = DEMO_PRESETS.find((preset) => preset.id === "fandom-con-nyc");
    const pinned = PINNED_PRESETS.find((preset) => preset.id === "fandom-con-nyc");
    expect(demo?.seeds.map((seed) => seed.rawText)).toEqual([
      "Jujutsu Kaisen",
      "YOASOBI",
      "Crunchyroll",
    ]);
    expect(demo?.seeds.map((seed) => seed.type)).toEqual([
      "urn:entity:tv_show",
      "urn:entity:artist",
      "urn:entity:brand",
    ]);
    expect(pinned?.seeds.map((seed) => seed.rawText)).toEqual(demo?.seeds.map((seed) => seed.rawText));
    expect(pinned?.seeds.every((seed) => Boolean(seed.entityId))).toBe(true);
    expect(pinned?.city).toBe("New York");
    expect(pinned?.eventKind).toBe("con");
  });

  it("falls back to movie only when fewer than 3 tv shows are valid", async () => {
    const calls: string[] = [];
    const short = await loadWatchHits(async (type) => {
      calls.push(type);
      if (type === "urn:entity:tv_show") return [{ entityId: "tv-1", name: "One" }, { entityId: " ", name: "Blank" }];
      return [{ entityId: "movie-1", name: "Film" }];
    });
    expect(calls).toEqual(["urn:entity:tv_show", "urn:entity:movie"]);
    expect(short.map((hit) => hit.entityId)).toEqual(["movie-1"]);

    calls.length = 0;
    const enough = await loadWatchHits(async (type) => {
      calls.push(type);
      return [
        { entityId: "tv-1", name: "One" },
        { entityId: "tv-2", name: "Two" },
        { entityId: "tv-3", name: "Three" },
      ];
    });
    expect(calls).toEqual(["urn:entity:tv_show"]);
    expect(enough).toHaveLength(3);
  });

  it("marks the place fallback as chosen by the city", async () => {
    const modes: string[] = [];
    const fallback = await loadPlaceHits(
      async (mode) => {
        modes.push(mode);
        return mode === "anchors"
          ? [{ entityId: "only-one", name: "Hall" }]
          : [{ entityId: "city-hall", name: "City Hall" }];
      },
      true,
      (hit) => Boolean(hit.entityId && hit.name),
    );
    expect(modes).toEqual(["anchors", "city"]);
    expect(fallback.chosenByCity).toBe(true);
    expect(fallback.hits[0]?.entityId).toBe("city-hall");

    modes.length = 0;
    const held = await loadPlaceHits(
      async (mode) => {
        modes.push(mode);
        return [
          { entityId: "a", name: "A" },
          { entityId: "b", name: "B" },
          { entityId: "c", name: "C" },
        ];
      },
      true,
      () => true,
    );
    expect(modes).toEqual(["anchors"]);
    expect(held.chosenByCity).toBe(false);
  });

  it("adds the deep-cuts popularity cap on listen, wear, and watch", () => {
    for (const slot of ["listen", "wear", "watch"] as const) {
      const deep = insightArgs({
        slot,
        eventKind: "tour",
        anchors: ["anchor"],
        city: "Houston",
        hop: 1,
        exclude: [],
        bridgeVariant: "deep",
      });
      const plain = insightArgs({
        slot,
        eventKind: "tour",
        anchors: ["anchor"],
        city: "Houston",
        hop: 1,
        exclude: [],
        bridgeVariant: "a",
      });
      expect(deep?.filterPopularityMax).toBe(0.9);
      expect(plain?.filterPopularityMax).toBeUndefined();
      expect(locationKey(deep!).includes("0.9")).toBe(true);
    }
    expect(
      insightArgs({
        slot: "watch",
        eventKind: "comunidad",
        anchors: ["anchor"],
        city: "Los Angeles",
        hop: 0,
        exclude: [],
      })?.filterType,
    ).toBe("urn:entity:tv_show");
  });

  it("writes only plan B and keeps root ids off that plan", () => {
    const item = (slot: "watch" | "listen" | "do", entityId: string, tags: string[]) => ({
      slot,
      entityId,
      name: entityId,
      type: slot === "do" ? "urn:entity:place" : "urn:entity:tv_show",
      hop: slot === "watch" && entityId.startsWith("bridge") ? 1 : 0,
      explain: { en: "—", es: "—" },
      confidence: "medium" as const,
      provenance: "qloo" as const,
      evidence: { hitTags: tags, ...(entityId === "city-hall" ? { chosenByCity: true } : {}) },
    });
    const assembled = assemblePack({
      sessionId: "s",
      city: "Houston",
      eventKind: "tour",
      seeds: [],
      coverage: { notes: { en: "", es: "" }, mode: "deep_cuts" },
      packs: [
        {
          label: "A",
          axis: "root",
          items: [item("listen", "root-listen", ["Pop"]), item("do", "root-do", ["Live music"])],
        },
        {
          label: "B",
          axis: "bridge",
          items: [
            item("listen", "root-listen", ["Pop"]),
            item("watch", "bridge-show", ["Drama"]),
            item("do", "city-hall", ["Live music"]),
          ],
        },
      ],
    });
    const root = assembled.packs.find((pack) => pack.label === "A");
    const write = packsToWrite(assembled);
    expect(write.label).toBe("B");
    expect(root?.items.map((entry) => entry.entityId)).toEqual(["root-listen", "root-do"]);
    expect(write.items.map((entry) => entry.entityId)).toEqual(["bridge-show", "city-hall"]);
    expect(write.items.some((entry) => entry.entityId === "root-listen")).toBe(false);
    expect(assembled.coverage.mode).toBe("deep_cuts");
    expect(write.items.find((entry) => entry.entityId === "city-hall")?.evidence?.chosenByCity).toBe(true);
  });
});

describe("anchor validation", () => {
  it("rejects ids from the same slot", () => {
    expect(validAnchorIds(candidates, ["watch-1", "watch-1"])).toBeNull();
  });
});

describe("bridge anchor rule B", () => {
  const weakWatch = { id: "watch-weak", name: "Show", slot: "watch" as const, tags: ["Drama"], sharedTagCount: 2 };
  const strongWatch = { id: "watch-strong", name: "Show", slot: "watch" as const, tags: ["Drama"], sharedTagCount: 5 };
  const listen = { id: "listen-best", name: "Artist", slot: "listen" as const, tags: ["Pop"], sharedTagCount: 4 };
  const listenLow = { id: "listen-low", name: "Other", slot: "listen" as const, tags: ["Pop"], sharedTagCount: 1 };
  const wear = { id: "wear-best", name: "Brand", slot: "wear" as const, tags: ["Cloth"], sharedTagCount: 3 };

  it("picks the best listen and wear and skips a weak watch", () => {
    expect(anchorsForRule([weakWatch, listenLow, listen, wear], new Set(), "B")).toEqual([
      "listen-best",
      "wear-best",
    ]);
  });

  it("includes watch when it shares at least five tags", () => {
    expect(anchorsForRule([strongWatch, listen, wear], new Set(), "B")).toEqual([
      "listen-best",
      "wear-best",
      "watch-strong",
    ]);
  });

  it("falls back to rule A when fewer than two anchors remain", () => {
    const onlyWatch = [strongWatch];
    expect(anchorsForRule(onlyWatch, new Set(["drama"]), "B")).toEqual(
      deterministicAnchors(onlyWatch, new Set(["drama"])),
    );
  });

  it("follows BRIDGE_ANCHOR_RULE", () => {
    const pool = [weakWatch, listen, wear];
    expect(anchorsForRule(pool, new Set())).toEqual(anchorsForRule(pool, new Set(), BRIDGE_ANCHOR_RULE));
    expect(anchorsForRule(pool, new Set(), "A")).not.toEqual(anchorsForRule(pool, new Set(), "B"));
  });
});

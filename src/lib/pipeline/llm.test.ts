import { afterEach, describe, expect, it, vi } from "vitest";
import { anchorsForRule, closedAnchorList, deterministicAnchors } from "@/lib/pipeline/anchors";
import { assemblePack } from "@/lib/pack/assemble";
import { LLM_TIMEOUT_MS } from "@/lib/pipeline/llm";
import { llmModelState, llmProviderId, llmStatus } from "@/lib/llm/provider";

const candidates = [
  { id: "watch-1", name: "Film", slot: "watch" as const, tags: ["Drama"] },
  { id: "listen-1", name: "Artist", slot: "listen" as const, tags: ["Pop"] },
  { id: "wear-1", name: "Brand", slot: "wear" as const, tags: ["Cloth"] },
];

const nebius = {
  LLM_PROVIDER: "nebius",
  NEBIUS_API_KEY: "test",
  NEBIUS_BASE_URL: "https://example.test/v1",
  NEBIUS_MODEL: "test-model",
};

function packStillAssembles(names: string[]) {
  const assembled = assemblePack({
    sessionId: "s",
    city: "Houston",
    eventKind: "tour",
    seeds: [],
    coverage: { notes: { en: "", es: "" } },
    packs: [
      {
        label: "A",
        axis: "root",
        items: names.map((name, index) => ({
          slot: index === 0 ? "listen" : "wear",
          entityId: name,
          name,
          type: "urn:entity:artist",
          hop: 0 as const,
          explain: { en: "—", es: "—" },
          confidence: "medium" as const,
          provenance: "qloo" as const,
        })),
      },
    ],
  });
  expect(assembled.packs[0]?.items.length).toBeGreaterThan(0);
}

async function loadLlm() {
  vi.resetModules();
  return import("@/lib/pipeline/llm");
}

function stubProvider() {
  vi.stubEnv("LLM_PROVIDER", "nebius");
  vi.stubEnv("NEBIUS_API_KEY", "test");
  vi.stubEnv("NEBIUS_BASE_URL", "https://example.test/v1");
  vi.stubEnv("NEBIUS_MODEL", "test-model");
}

describe("llm provider selection", () => {
  it("uses nebius when LLM_PROVIDER is empty but the Nebius variables are set", () => {
    expect(llmProviderId(nebius)).toBe("nebius");
    const state = llmModelState(nebius);
    expect(state.configured).toBe(true);
    expect(state.configured && state.provider).toBe("nebius");
  });

  it("selects google from LLM_PROVIDER", () => {
    const state = llmModelState({
      LLM_PROVIDER: "google",
      GOOGLE_GENERATIVE_AI_API_KEY: "test",
      LLM_MODEL: "gemini-2.5-flash",
    });
    expect(state.configured).toBe(true);
    expect(state.configured && state.provider).toBe("google");
    expect(state.configured && state.modelId).toBe("gemini-2.5-flash");
  });

  it("turns the LLM off when google has no LLM_MODEL", () => {
    const state = llmModelState({
      LLM_PROVIDER: "google",
      GOOGLE_GENERATIVE_AI_API_KEY: "test",
    });
    expect(state).toEqual({ configured: false, reason: "missing:LLM_MODEL" });
    expect(llmStatus({ LLM_PROVIDER: "google" }).offReason).toContain("LLM_MODEL");
  });

  it("turns the LLM off when every variable is missing", () => {
    const state = llmModelState({});
    expect(state.configured).toBe(false);
    expect(llmStatus({}).provider).toBeNull();
  });

  it("turns the LLM off on an unknown provider name", () => {
    expect(llmModelState({ LLM_PROVIDER: "openai" })).toEqual({
      configured: false,
      reason: "unknown_provider:openai",
    });
  });
});

describe("llm fallbacks", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("ai");
    vi.useRealTimers();
    vi.resetModules();
  });

  it("falls back when the model returns invalid JSON", async () => {
    stubProvider();
    vi.doMock("ai", () => ({
      generateObject: vi.fn(async () => {
        throw new Error("unsupported");
      }),
    }));
    const { chooseBridgeAnchors } = await loadLlm();
    const choice = await chooseBridgeAnchors(candidates);
    expect(choice.source).toBe("fallback");
    expect(choice.anchorSource).toBe("rule_b_fallback");
    expect(choice.failure).toBe("request");
    expect(choice.ids).toEqual(anchorsForRule(candidates));
    packStillAssembles(choice.ids);
  });

  it("falls back when an anchor id is not in the closed list", async () => {
    stubProvider();
    vi.doMock("ai", () => ({
      generateObject: vi.fn(async () => ({ object: { anchorIds: ["not-a-real-id", "watch-1"], reason: "" } })),
    }));
    const { chooseBridgeAnchors } = await loadLlm();
    const choice = await chooseBridgeAnchors(candidates);
    expect(choice).toMatchObject({ source: "fallback", failure: "unknown_id", anchorSource: "rule_b_fallback" });
    expect(choice.ids).toEqual(anchorsForRule(candidates));
    packStillAssembles(choice.ids);
  });

  it("falls back when two anchors come from the same slot", async () => {
    stubProvider();
    const twoListens = [
      { id: "listen-1", name: "A", slot: "listen" as const, tags: ["Pop"] },
      { id: "listen-2", name: "B", slot: "listen" as const, tags: ["Rock"] },
      { id: "wear-1", name: "Brand", slot: "wear" as const, tags: ["Cloth"] },
    ];
    vi.doMock("ai", () => ({
      generateObject: vi.fn(async () => ({ object: { anchorIds: ["listen-1", "listen-2"], reason: "" } })),
    }));
    const { chooseBridgeAnchors } = await loadLlm();
    const choice = await chooseBridgeAnchors(twoListens, new Set(["pop", "rock", "cloth"]));
    expect(choice).toMatchObject({ failure: "same_slot", source: "fallback" });
    expect(choice.anchorSource).toBe("rule_b_fallback");
    packStillAssembles(choice.ids);
  });

  it("accepts a choice made inside the closed list and marks it as llm", async () => {
    stubProvider();
    vi.doMock("ai", () => ({
      generateObject: vi.fn(async () => ({ object: { anchorIds: ["listen-1", "wear-1"], reason: "shared tags" } })),
    }));
    const { chooseBridgeAnchors } = await loadLlm();
    const choice = await chooseBridgeAnchors(candidates, new Set(["pop", "cloth"]));
    expect(choice.source).toBe("llm");
    expect(choice.anchorSource).toBe("llm");
    expect(choice.ids).toEqual(["listen-1", "wear-1"]);
    expect(choice.reason).toBe("shared tags");
    expect(choice.evidence).toEqual([
      {
        id: "listen-1",
        name: "Artist",
        slot: "listen",
        sharedTags: ["Pop"],
        sharedTagCount: 1,
        confidence: "low",
      },
      {
        id: "wear-1",
        name: "Brand",
        slot: "wear",
        sharedTags: ["Cloth"],
        sharedTagCount: 1,
        confidence: "low",
      },
    ]);
  });

  it("never offers a zero-shared watch while two candidates do share tags", async () => {
    const pool = [
      { id: "listen-1", name: "A", slot: "listen" as const, tags: ["Pop", "Dance"], sharedTagCount: 2 },
      { id: "wear-1", name: "B", slot: "wear" as const, tags: ["Cloth"], sharedTagCount: 1 },
      { id: "watch-1", name: "C", slot: "watch" as const, tags: ["Drama"], sharedTagCount: 0 },
    ];
    const closed = closedAnchorList(pool, new Set(["pop", "dance", "cloth"]));
    expect(closed.map((anchor) => anchor.id)).toEqual(["listen-1", "wear-1"]);
    expect(anchorsForRule(pool, new Set(["pop", "dance", "cloth"]), "B")).toEqual(["listen-1", "wear-1"]);
    expect(deterministicAnchors(pool, new Set(["pop", "dance", "cloth"]))).not.toContain("watch-1");
  });

  it("breaks ties deterministically on rank then id", () => {
    const tied = [
      { id: "listen-b", name: "B", slot: "listen" as const, tags: ["Pop"], sharedTagCount: 3, rank: 1 },
      { id: "listen-a", name: "A", slot: "listen" as const, tags: ["Pop"], sharedTagCount: 3, rank: 0 },
      { id: "wear-1", name: "W", slot: "wear" as const, tags: ["Cloth"], sharedTagCount: 3, rank: 2 },
    ];
    const first = closedAnchorList(tied, new Set(["pop", "cloth"]));
    const second = closedAnchorList([...tied].reverse(), new Set(["pop", "cloth"]));
    expect(first.map((anchor) => anchor.id)).toEqual(second.map((anchor) => anchor.id));
    expect(first[0]?.id).toBe("listen-a");
    expect(anchorsForRule(tied, new Set(["pop", "cloth"]), "B")).toEqual(["listen-a", "wear-1"]);
  });

  it("marks an anchor with three shared tags as high confidence", () => {
    const strong = [
      { id: "listen-1", name: "A", slot: "listen" as const, tags: ["Pop", "Dance", "Latin"], sharedTagCount: 3 },
      { id: "wear-1", name: "B", slot: "wear" as const, tags: ["Cloth"], sharedTagCount: 2 },
    ];
    const closed = closedAnchorList(strong, new Set(["pop", "dance", "latin", "cloth"]));
    expect(closed.map((anchor) => anchor.confidence)).toEqual(["high", "medium"]);
  });

  it("turns the narrative into the template when a token is unknown", async () => {
    stubProvider();
    vi.doMock("ai", () => ({
      generateObject: vi.fn(async () => ({
        object: {
          rootsNarrative: "[[ticket]] time.",
          rootsHeadline: "Roots",
          bridgeNarrative: "[[listen]] next.",
          bridgeHeadline: "Bridge",
        },
      })),
    }));
    const { composeNarratives } = await loadLlm();
    const choice = await composeNarratives({
      locale: "en",
      plans: [
        { label: "A", city: "Houston", anchors: [{ name: "Bad Bunny" }], slots: { listen: "Karol G" } },
        { label: "B", city: "Houston", anchors: [{ name: "Bad Bunny" }], slots: { wear: "Nike" } },
      ],
    });
    expect(choice.failures).toContain("unknown_token");
    expect(choice.plans.map((plan) => plan.source)).toEqual(["template", "template"]);
    expect(choice.plans[0]?.text).toBe("Tonight: Karol G.");
  });

  it("repairs once and then succeeds", async () => {
    stubProvider();
    const responses = [
      { object: { rootsNarrative: "[[do]] now.", rootsHeadline: "R", bridgeNarrative: "[[listen]] now.", bridgeHeadline: "B" } },
      { object: { rootsNarrative: "[[listen]] now.", rootsHeadline: "R", bridgeNarrative: "[[listen]] then.", bridgeHeadline: "B" } },
    ];
    vi.doMock("ai", () => ({
      generateObject: vi.fn(async () => responses.shift()),
    }));
    const { composeNarratives } = await loadLlm();
    const choice = await composeNarratives({
      locale: "en",
      plans: [
        { label: "A", city: "Houston", anchors: [{ name: "Bad Bunny" }], slots: { listen: "Karol G" } },
        { label: "B", city: "Houston", anchors: [{ name: "Bad Bunny" }], slots: { listen: "Karol G" } },
      ],
    });
    expect(choice.failures).toContain("unknown_token");
    expect(choice.plans.map((plan) => plan.source)).toEqual(["llm", "llm"]);
    expect(choice.plans[0]?.text).toBe("Karol G now.");
  });

  it("keeps the template when the LLM is off", async () => {
    for (const name of ["NEBIUS_API_KEY", "NEBIUS_BASE_URL", "NEBIUS_MODEL", "LLM_PROVIDER", "LLM_MODEL"]) {
      vi.stubEnv(name, "");
    }
    const { composeNarratives } = await loadLlm();
    const choice = await composeNarratives({
      locale: "es",
      plans: [
        { label: "A", city: "Nueva York", anchors: [], slots: { watch: "Chainsaw Man" } },
        { label: "B", city: "Nueva York", anchors: [], slots: {} },
      ],
    });
    expect(choice.provider).toBeNull();
    expect(choice.offReason).toContain("missing");
    expect(choice.plans[0]).toMatchObject({ source: "template", text: "Esta noche: Chainsaw Man." });
    expect(choice.plans[1]).toMatchObject({ source: "template", text: "No hubo recomendaciones." });
  });

  it("falls back to the template when a narrative call exceeds 12 seconds", async () => {
    vi.useFakeTimers();
    stubProvider();
    vi.doMock("ai", () => ({
      generateObject: vi.fn(() => new Promise(() => {})),
    }));
    const { composeNarratives } = await loadLlm();
    const pending = composeNarratives({
      locale: "en",
      plans: [{ label: "A", city: "Houston", anchors: [], slots: { listen: "Karol G" } }],
    });
    await vi.advanceTimersByTimeAsync(LLM_TIMEOUT_MS);
    const choice = await pending;
    expect(choice.failures).toEqual(["timeout"]);
    expect(choice.plans[0]).toMatchObject({ source: "template", text: "Tonight: Karol G." });
  });

  it("falls back when an anchor call exceeds 6 seconds", async () => {
    vi.useFakeTimers();
    stubProvider();
    vi.doMock("ai", () => ({
      generateObject: vi.fn(() => new Promise(() => {})),
    }));
    const { chooseBridgeAnchors, ANCHOR_TIMEOUT_MS } = await loadLlm();
    const pending = chooseBridgeAnchors(candidates);
    await vi.advanceTimersByTimeAsync(ANCHOR_TIMEOUT_MS);
    const choice = await pending;
    expect(choice.source).toBe("fallback");
    expect(choice.failure).toBe("timeout");
    expect(choice.ids).toEqual(anchorsForRule(candidates));
    packStillAssembles(choice.ids);
  });
});

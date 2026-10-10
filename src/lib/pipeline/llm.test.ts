import { afterEach, describe, expect, it, vi } from "vitest";
import { anchorsForRule } from "@/lib/pipeline/anchors";
import { assemblePack } from "@/lib/pack/assemble";
import { LLM_TIMEOUT_MS } from "@/lib/pipeline/llm";

const candidates = [
  { id: "watch-1", name: "Film", slot: "watch" as const, tags: ["Drama"] },
  { id: "listen-1", name: "Artist", slot: "listen" as const, tags: ["Pop"] },
  { id: "wear-1", name: "Brand", slot: "wear" as const, tags: ["Cloth"] },
];

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

describe("llm fallbacks", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("ai");
    vi.useRealTimers();
    vi.resetModules();
  });

  it("falls back when the model returns invalid JSON", async () => {
    vi.stubEnv("NEBIUS_API_KEY", "test");
    vi.stubEnv("NEBIUS_BASE_URL", "https://example.test/v1");
    vi.stubEnv("NEBIUS_MODEL", "test-model");
    vi.doMock("ai", () => ({
      generateObject: vi.fn(async () => {
        throw new Error("unsupported");
      }),
      generateText: vi.fn(async () => ({ text: "not json" })),
    }));
    const { chooseBridgeAnchors } = await loadLlm();
    const choice = await chooseBridgeAnchors(candidates);
    expect(choice.source).toBe("fallback");
    expect(choice.failure).toBe("invalid_json");
    expect(choice.ids).toEqual(anchorsForRule(candidates));
    packStillAssembles(choice.ids);
  });

  it("falls back when an anchor id is not in the candidate list", async () => {
    vi.stubEnv("NEBIUS_API_KEY", "test");
    vi.stubEnv("NEBIUS_BASE_URL", "https://example.test/v1");
    vi.stubEnv("NEBIUS_MODEL", "test-model");
    vi.doMock("ai", () => ({
      generateObject: vi.fn(async () => ({ object: { ids: ["not-a-real-id", "watch-1"] } })),
      generateText: vi.fn(),
    }));
    const { chooseBridgeAnchors } = await loadLlm();
    const choice = await chooseBridgeAnchors(candidates);
    expect(choice).toMatchObject({ source: "fallback", failure: "unknown_id" });
    expect(choice.ids).toEqual(anchorsForRule(candidates));
    packStillAssembles(choice.ids);
  });

  it("falls back when the anchors come from the same slot", async () => {
    vi.stubEnv("NEBIUS_API_KEY", "test");
    vi.stubEnv("NEBIUS_BASE_URL", "https://example.test/v1");
    vi.stubEnv("NEBIUS_MODEL", "test-model");
    vi.doMock("ai", () => ({
      generateObject: vi.fn(async () => ({ object: { ids: ["watch-1", "watch-1"] } })),
      generateText: vi.fn(),
    }));
    const { chooseBridgeAnchors } = await loadLlm();
    const choice = await chooseBridgeAnchors(candidates);
    expect(choice.failure).toBe("same_slot");
    expect(choice.source).toBe("fallback");
    packStillAssembles(choice.ids);
  });

  it("falls back when the narrative mentions a name outside the plan", async () => {
    vi.stubEnv("NEBIUS_API_KEY", "test");
    vi.stubEnv("NEBIUS_BASE_URL", "https://example.test/v1");
    vi.stubEnv("NEBIUS_MODEL", "test-model");
    vi.doMock("ai", () => ({
      generateObject: vi.fn(async () => ({ object: { text: "Tonight with Shakira." } })),
      generateText: vi.fn(),
    }));
    const { composeNarrative } = await loadLlm();
    const choice = await composeNarrative({
      locale: "en",
      names: ["Bad Bunny"],
      allowed: ["Bad Bunny", "Houston"],
    });
    expect(choice.source).toBe("template");
    expect(choice.failure).toBe("unknown_name");
    expect(choice.text).toBe("Tonight: Bad Bunny.");
    packStillAssembles(["Bad Bunny"]);
  });

  it("falls back when an LLM call exceeds 15 seconds", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NEBIUS_API_KEY", "test");
    vi.stubEnv("NEBIUS_BASE_URL", "https://example.test/v1");
    vi.stubEnv("NEBIUS_MODEL", "test-model");
    vi.doMock("ai", () => ({
      generateObject: vi.fn(() => new Promise(() => {})),
      generateText: vi.fn(() => new Promise(() => {})),
    }));
    const { chooseBridgeAnchors } = await loadLlm();
    const pending = chooseBridgeAnchors(candidates);
    await vi.advanceTimersByTimeAsync(LLM_TIMEOUT_MS);
    const choice = await pending;
    expect(choice.source).toBe("fallback");
    expect(choice.failure).toBe("timeout");
    expect(choice.ids).toEqual(anchorsForRule(candidates));
    packStillAssembles(choice.ids);
  });
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { PackCachePayload } from "@/lib/pack/cache";
import {
  createDropQMcpServer,
  packNightInputSchema,
  toPackNightResult,
  toPlanResult,
  type McpServerDeps,
  type PackNightInput,
} from "./tools";

const SLOTS = ["watch", "listen", "wear", "do"] as const;

function item(slot: (typeof SLOTS)[number], label: "A" | "B") {
  return {
    slot,
    position: SLOTS.indexOf(slot),
    hop: label === "A" ? 0 : 1,
    qlooEntityId: `entity-${label.toLowerCase()}-${slot}`,
    qlooName: `${label} ${slot}`,
    qlooType: "urn:entity:artist",
    imageUrl: null,
    affinityScore: 0.5,
    explain: "Reggaeton, Energetic",
    evidence: {
      hitTags: ["Reggaeton", "Energetic"],
      sharedTags: ["Reggaeton"],
      sharedTagCount: 1,
    },
    confidence: "medium" as const,
    provenance: "qloo" as const,
  };
}

function payload(anchors = ["Ricardo Arjona", "Pollo Campero", "Gaby Moreno"]): PackCachePayload {
  return {
    city: "Los Angeles",
    eventKind: "comunidad",
    locale: "en",
    seeds: anchors.map((rawText, index) => ({
      rawText,
      source: "text" as const,
      resolvedEntityId: `seed-${index + 1}`,
      resolvedName: rawText,
      domain: index === 1 ? ("brand" as const) : ("artist" as const),
    })),
    packs: [
      {
        label: "A",
        axis: "root",
        narrative: "Tonight: A watch, A listen, A wear, A do.",
        coverage: {
          notes: { en: "", es: "" },
          llm: { anchors: "llm", narrative: "llm", headline: "Roots", offReason: null },
        },
        items: SLOTS.map((slot) => item(slot, "A")),
      },
      {
        label: "B",
        axis: "bridge",
        narrative: "Tonight: B watch, B listen, B wear, B do.",
        coverage: {
          notes: { en: "", es: "" },
          llm: { anchors: "llm", narrative: "llm", headline: "Bridge", offReason: null },
          bridgeMode: "default",
          ruleB: { anchors: [{ id: "seed-1", name: "Ricardo Arjona", slot: "listen" }] },
        },
        items: SLOTS.map((slot) => item(slot, "B")),
      },
    ],
  };
}

function deps(overrides: Partial<McpServerDeps> = {}): McpServerDeps {
  const source = payload();
  return {
    request: new Request("https://dropq.focampo.com/api/mcp"),
    publicBaseUrl: "https://dropq.focampo.com",
    enforceRateLimit: vi.fn(() => null),
    createSession: vi.fn(async () => "session-1"),
    buildPack: vi.fn(async () => ({ ok: true as const, cached: true, events: [] })),
    refineDeepCuts: vi.fn(async () => ({
      ok: true as const,
      cached: false,
      events: [{ step: "insights_hop1", status: "skipped", detail: "snapshot" }],
    })),
    loadPack: vi.fn(async () => ({
      payload: source,
      packIds: { A: "pack-a", B: "pack-b" },
    })),
    listPresets: vi.fn(async () => [
      {
        id: "roots-gt-la",
        city: "Los Angeles",
        eventKind: "comunidad",
        anchors: source.seeds.map((seed) => ({
          rawText: seed.rawText,
          resolvedName: seed.resolvedName,
          entityId: seed.resolvedEntityId,
        })),
        locales: {
          en: {
            builtAt: "2026-10-27T00:00:00.000Z",
            plans: source.packs.map((pack) => toPlanResult(pack)),
          },
        },
      },
    ]),
    deleteSession: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function connect(d: McpServerDeps) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  const server = createDropQMcpServer(d);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function bodyOf(result: unknown): Record<string, unknown> {
  const content = Array.isArray((result as { content?: unknown })?.content)
    ? ((result as { content: unknown[] }).content)
    : [];
  const block = content.find(
    (entry) => entry && typeof entry === "object" && (entry as { type?: unknown }).type === "text",
  ) as { text?: unknown } | undefined;
  if (!block || typeof block.text !== "string") {
    throw new Error("tool result has no text block");
  }
  return JSON.parse(block.text) as Record<string, unknown>;
}

const PRESET_ARGS: PackNightInput = {
  anchors: ["Ricardo Arjona", "Pollo Campero", "Gaby Moreno"],
  city: "Los Angeles",
  event_kind: "comunidad",
};

describe("MCP input schema", () => {
  it("requires 3–5 distinct, sanitized anchors", () => {
    const base = { city: "Los Angeles", event_kind: "comunidad" };
    expect(packNightInputSchema.safeParse({ ...base, anchors: ["a", "b"] }).success).toBe(false);
    expect(packNightInputSchema.safeParse({ ...base, anchors: ["a", "b", "c", "d", "e", "f"] }).success).toBe(false);
    expect(packNightInputSchema.safeParse({ ...base, anchors: ["a", "a", "b"] }).success).toBe(false);
    const parsed = packNightInputSchema.parse({ ...base, anchors: [" A \n B ", "C", "D"] });
    expect(parsed.anchors[0]).toBe("A B");
  });

  it("rejects a city or event kind outside the app enums", () => {
    expect(
      packNightInputSchema.safeParse({ ...PRESET_ARGS, city: "Atlantis" }).success,
    ).toBe(false);
    expect(
      packNightInputSchema.safeParse({ ...PRESET_ARGS, event_kind: "rave" }).success,
    ).toBe(false);
  });
});

describe("pack_night output", () => {
  it("carries both plans, every entity id, stored evidence and the brief link", () => {
    const result = toPackNightResult({
      input: PRESET_ARGS,
      sessionId: "session-1",
      loaded: { payload: payload(), packIds: { A: "pack-a", B: "pack-b" } },
      cached: true,
      deepCuts: "not_requested",
      publicBaseUrl: "https://dropq.focampo.com",
    });

    expect(result.plans.map((plan) => plan.label)).toEqual(["A", "B"]);
    for (const plan of result.plans) {
      expect(plan.items.map((entry) => entry.slot)).toEqual([...SLOTS]);
      for (const entry of plan.items) {
        expect(entry.entityId).toMatch(/^entity-/);
        expect(entry.evidence).toMatchObject({ hitTags: expect.any(Array) });
      }
    }
    expect(result.anchors.map((anchor) => anchor.entityId)).toEqual(["seed-1", "seed-2", "seed-3"]);
    expect(result.briefUrl).toBe("https://dropq.focampo.com/packs/pack-b/brief");
    expect(result.briefAccess).toBe("public");
    expect(result.cache.pack).toBe("hit");
    expect(result.deepCuts).toEqual({ requested: false, bridge: "not_requested" });
  });

  it("marks a custom pack's brief as session-owned", () => {
    const custom = toPackNightResult({
      input: { ...PRESET_ARGS, anchors: ["One", "Two", "Three"] },
      sessionId: "session-2",
      loaded: {
        payload: payload(["One", "Two", "Three"]),
        packIds: { A: "pack-a", B: null },
      },
      cached: false,
      deepCuts: "not_requested",
      publicBaseUrl: "https://dropq.focampo.com/",
    });
    expect(custom.briefAccess).toBe("session");
    expect(custom.briefUrl).toBe("https://dropq.focampo.com/packs/pack-a/brief");
    expect(custom.cache.pack).toBe("miss");
  });
});

describe("MCP server tools", () => {
  it("lists pack_night and list_presets", async () => {
    const { client, server } = await connect(deps());
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(["list_presets", "pack_night"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("pack_night delegates to the same build path and returns JSON", async () => {
    const d = deps();
    const { client, server } = await connect(d);
    try {
      const result = await client.callTool({ name: "pack_night", arguments: PRESET_ARGS });
      expect(result.isError).toBeFalsy();
      const body = bodyOf(result);
      expect(body.plans).toHaveLength(2);
      expect(body.briefUrl).toBe("https://dropq.focampo.com/packs/pack-b/brief");
      expect(body.cache).toEqual({ pack: "hit" });
      expect(d.createSession).toHaveBeenCalledWith({
        anchors: PRESET_ARGS.anchors,
        city: "Los Angeles",
        eventKind: "comunidad",
        locale: "en",
      });
      expect(d.buildPack).toHaveBeenCalledWith("session-1", "en", d.request);
      expect(d.refineDeepCuts).not.toHaveBeenCalled();
      expect(d.deleteSession).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("pack_night reports a Deep cuts snapshot without claiming a rebuild", async () => {
    const d = deps();
    const { client, server } = await connect(d);
    try {
      const result = await client.callTool({
        name: "pack_night",
        arguments: { ...PRESET_ARGS, deep_cuts: true },
      });
      const body = bodyOf(result);
      expect(body.deepCuts).toEqual({ requested: true, bridge: "snapshot" });
      expect(d.refineDeepCuts).toHaveBeenCalledWith("session-1", d.request);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses above the rate limit before creating a session", async () => {
    const d = deps({
      enforceRateLimit: vi.fn(() => ({ status: 429, code: "rate_limited" })),
    });
    const { client, server } = await connect(d);
    try {
      const result = await client.callTool({ name: "pack_night", arguments: PRESET_ARGS });
      expect(result.isError).toBe(true);
      expect(bodyOf(result).error).toMatchObject({ code: "rate_limited", status: 429 });
      expect(d.createSession).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("cleans up the session when the shared pack route refuses", async () => {
    const d = deps({
      buildPack: vi.fn(async () => ({
        ok: false as const,
        status: 503,
        error: "DEMO_RESTING",
        message: "The live demo is resting.",
      })),
    });
    const { client, server } = await connect(d);
    try {
      const result = await client.callTool({ name: "pack_night", arguments: PRESET_ARGS });
      expect(result.isError).toBe(true);
      expect(bodyOf(result).error).toMatchObject({
        code: "DEMO_RESTING",
        message: "The live demo is resting.",
      });
      expect(d.deleteSession).toHaveBeenCalledWith("session-1");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("list_presets returns the cached rows", async () => {
    const d = deps();
    const { client, server } = await connect(d);
    try {
      const result = await client.callTool({ name: "list_presets", arguments: {} });
      expect(result.isError).toBeFalsy();
      const body = bodyOf(result) as { presets: { id: string; locales: Record<string, unknown> }[]; note: string };
      expect(body.presets[0]?.id).toBe("roots-gt-la");
      expect(Object.keys(body.presets[0]?.locales ?? {})).toEqual(["en"]);
      expect(body.note).toContain("no Qloo or Gemini quota");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

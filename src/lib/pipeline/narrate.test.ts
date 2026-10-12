import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InsightsParams } from "@/lib/qloo/types";

type Row = Record<string, unknown>;
type Pack = { id: string; label: "A" | "B"; axis: string; narrative: string | null; coverage: Row | null; items: Row[] };
type Session = { id: string; city: string; locale: string; eventKind: string; seeds: Row[]; packs: Pack[] };

const { state, aiState } = vi.hoisted(() => ({
  state: { session: null as Session | null, placeCalls: 0 },
  aiState: { generateObject: (async () => ({ object: {} })) as (args: unknown) => Promise<unknown> },
}));

// A module-scope mock is required: run.ts imports the LLM layer statically, so
// vi.doMock inside a test would arrive too late. Tests point aiState at their own stub.
vi.mock("ai", () => ({
  generateObject: (args: unknown) => aiState.generateObject(args),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    session: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.session?.id === where.id ? state.session : null,
      update: async () => state.session,
    },
    seed: { update: async () => ({}) },
    pack: {
      findMany: async ({ where }: { where: { sessionId: string } }) =>
        state.session?.id === where.sessionId ? state.session.packs : [],
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const pack = state.session?.packs.find((entry) => entry.id === where.id);
        if (pack) Object.assign(pack, data);
        return pack;
      },
    },
    qlooEntityCache: { findMany: async () => [], upsert: async () => ({}) },
    insightCache: { findUnique: async () => null, upsert: async () => ({}) },
    entityTagCache: { findMany: async () => [], upsert: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        pack: {
          deleteMany: async () => {
            if (state.session) state.session.packs = [];
          },
          update: async ({ where, data }: { where: { id: string }; data: Row }) => {
            const pack = state.session?.packs.find((entry) => entry.id === where.id);
            if (!pack) return null;
            const items = (data.items as { create?: Row[] } | undefined)?.create;
            if (items) pack.items = items.map((item, index) => ({ id: `item-${index}`, ...item }));
            Object.assign(pack, { narrative: data.narrative ?? pack.narrative, coverage: data.coverage ?? pack.coverage });
            return pack;
          },
          create: async ({ data }: { data: Row }) => {
            const pack: Pack = {
              id: `pack-${data.label as string}`,
              label: data.label as "A" | "B",
              axis: data.axis as string,
              narrative: (data.narrative as string | null) ?? null,
              coverage: (data.coverage as Row) ?? null,
              items: ((data.items as { create?: Row[] })?.create ?? []).map((item, index) => ({
                id: `item-${index}`,
                ...item,
              })),
            };
            state.session?.packs.push(pack);
            return pack;
          },
        },
        session: { update: async () => state.session },
        packItem: { deleteMany: async () => undefined },
      }),
  },
}));

vi.mock("@/lib/qloo/client", () => ({
  search: async () => ({
    provenance: "qloo",
    results: [
      {
        entityId: "seed-1",
        name: "Bad Bunny",
        type: "urn:entity:artist",
        imageUrl: null,
        raw: { tags: [{ name: "Latin" }, { name: "Pop" }] },
      },
    ],
  }),
  insights: async (args: InsightsParams) => {
    const type = args.filterType;
    if (type === "urn:entity:place") {
      state.placeCalls += 1;
      const hop = state.placeCalls > 1 ? "bridge" : "root";
      return {
        provenance: "qloo",
        results: [
          {
            entityId: `${hop}-do`,
            name: `${hop} do`,
            type,
            imageUrl: null,
            properties: {},
            raw: { tags: [{ name: "Live" }] },
          },
        ],
        raw: {},
      };
    }
    const slot = type?.endsWith(":tv_show") || type?.endsWith(":movie")
      ? "watch"
      : type?.endsWith(":artist")
        ? "listen"
        : "wear";
    const hop = (args.signalInterestsEntities ?? []).some((id) => id.startsWith("root-")) ? "bridge" : "root";
    const tags =
      slot === "listen" ? [{ name: "Latin" }, { name: "Pop" }] : slot === "wear" ? [{ name: "Pop" }] : [{ name: "Drama" }];
    const count = slot === "watch" ? 3 : 1;
    return {
      provenance: "qloo",
      results: Array.from({ length: count }, (_, index) => ({
        entityId: `${hop}-${slot}${index === 0 ? "" : `-${index}`}`,
        name: `${hop} ${slot}${index === 0 ? "" : ` ${index}`}`,
        type,
        imageUrl: null,
        properties: {},
        raw: { tags, affinity: 0.4 },
      })),
      raw: {},
    };
  },
  // The real extractor, inline: the mock replaces the whole client module.
  entityTagNames: (raw: { tags?: { name?: unknown }[] }) =>
    Array.isArray(raw?.tags)
      ? raw.tags.flatMap((tag) => (typeof tag?.name === "string" ? [tag.name] : []))
      : [],
  entitiesByIds: async () => ({ provenance: "qloo", results: [] }),
  qlooQuota: () => ({ blocked: false }),
}));

import { runPipeline, refineBridge } from "@/lib/pipeline/run";

function narrativeOf(label: "A" | "B"): string | null {
  return state.session?.packs.find((pack) => pack.label === label)?.narrative ?? null;
}

function llmOf(label: "A" | "B"): Record<string, unknown> | undefined {
  const coverage = state.session?.packs.find((pack) => pack.label === label)?.coverage;
  return coverage?.llm as Record<string, unknown> | undefined;
}

type Event = { step: string; status: string; detail?: string };

function useSession() {
  state.placeCalls = 0;
  state.session = {
    id: "session-1",
    city: "Houston",
    locale: "en",
    eventKind: "tour",
    seeds: [
      {
        id: "seed-row-1",
        rawText: "Bad Bunny",
        resolvedEntityId: null,
        resolvedName: null,
        domain: "artist",
      },
    ],
    packs: [],
  };
  return "session-1";
}

const ROOTS_TEMPLATE = "Tonight: root watch, root listen, root wear, root do.";
const BRIDGE_TEMPLATE = "Tonight: bridge watch, bridge listen, bridge wear, bridge do.";

const anchorResponse = { object: { anchorIds: ["root-listen", "root-wear"], reason: "shared tags" } };

function stubProvider() {
  vi.stubEnv("LLM_PROVIDER", "nebius");
  vi.stubEnv("NEBIUS_API_KEY", "test");
  vi.stubEnv("NEBIUS_BASE_URL", "https://example.test/v1");
  vi.stubEnv("NEBIUS_MODEL", "test-model");
}

describe("narration runs after the pack is stored", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.stubEnv("QLOO_API_KEY", "test-key");
    aiState.generateObject = async () => ({ object: {} });
  });

  it("stores the template first, then swaps in the LLM text at narrate", async () => {
    stubProvider();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let call = 0;
    aiState.generateObject = async () => {
        call += 1;
        if (call === 1) return anchorResponse;
        await gate;
        return {
          object: {
            rootsNarrative: "[[listen]] opens the night.",
            rootsHeadline: "Start with [[listen]]",
            bridgeNarrative: "Then [[wear]] with [[do]].",
            bridgeHeadline: "Close in [[city]]",
          },
        };
    };
    const sessionId = useSession();
    const events: Event[] = [];
    const seenAtAssemble: (string | null)[] = [];
    const pending = runPipeline(sessionId, (event) => {
      events.push(event as Event);
      if (event.step === "assemble" && event.status === "done") seenAtAssemble.push(narrativeOf("A"));
    });
    while (!events.some((event) => event.step === "assemble" && event.status === "done")) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // First paint: the pack is already stored and only the template exists.
    expect(seenAtAssemble[0]).toBe(ROOTS_TEMPLATE);
    expect(events.some((event) => event.step === "narrate" && event.status === "done")).toBe(false);
    expect(llmOf("A")?.narrative).toBe("template");
    expect(llmOf("A")?.anchorSource).toBe("llm");

    release!();
    await pending;

    expect(narrativeOf("A")).toBe("root listen opens the night.");
    expect(narrativeOf("B")).toBe("Then bridge wear with bridge do.");
    expect(llmOf("A")).toMatchObject({ narrative: "llm", headline: "Start with root listen", provider: "nebius" });
    expect(llmOf("B")).toMatchObject({ narrative: "llm", headline: "Close in Houston" });
    const order = events.map((event) => `${event.step}:${event.status}`);
    expect(order.indexOf("assemble:done")).toBeLessThan(order.indexOf("narrate:done"));
    expect(order.indexOf("narrate:done")).toBeLessThan(order.indexOf("done:done"));
  });

  it("keeps the template and records the failure when a token is unknown", async () => {
    stubProvider();
    let call = 0;
    aiState.generateObject = async () => {
      call += 1;
      if (call === 1) return anchorResponse;
      return {
        object: {
          rootsNarrative: "[[soldout]] tonight.",
          rootsHeadline: "Roots",
          bridgeNarrative: "[[wear]] tonight.",
          bridgeHeadline: "Bridge",
        },
      };
    };
    const sessionId = useSession();
    await runPipeline(sessionId, () => undefined);

    expect(narrativeOf("A")).toBe(ROOTS_TEMPLATE);
    expect(narrativeOf("B")).toBe(BRIDGE_TEMPLATE);
    expect(llmOf("A")?.narrative).toBe("template");
    expect(llmOf("A")?.failures).toContain("unknown_token");
    // The badge reads this flag per plan, so a template plan never shows it.
    expect(llmOf("B")?.narrative).toBe("template");
  });

  it("records the failure codes even when every narrative falls back", async () => {
    stubProvider();
    let call = 0;
    aiState.generateObject = async () => {
      call += 1;
      if (call === 1) return anchorResponse;
      return {
        object: {
          rootsNarrative: "[[soldout]] tonight.",
          rootsHeadline: "Roots",
          bridgeNarrative: "[[soldout]] tomorrow.",
          bridgeHeadline: "Bridge",
        },
      };
    };
    const sessionId = useSession();
    await runPipeline(sessionId, () => undefined);
    // Both plans stayed on the template, so nothing was written for the text, but the
    // reason has to reach coverage or the fallback rate is not measurable.
    expect(narrativeOf("A")).toBe(ROOTS_TEMPLATE);
    expect(narrativeOf("B")).toBe(BRIDGE_TEMPLATE);
    expect(llmOf("A")).toMatchObject({ narrative: "template", provider: "nebius" });
    expect(llmOf("A")?.failures).toEqual(["unknown_token", "unknown_token"]);
    expect(llmOf("B")?.failures).toEqual(["unknown_token", "unknown_token"]);
  });

  it("keeps Plan A's narrative when only the Bridge is refined", async () => {
    stubProvider();
    let call = 0;
    aiState.generateObject = async () => {
      call += 1;
      if (call === 1) return anchorResponse;
      return {
        object: {
          rootsNarrative: "[[listen]] opens.",
          rootsHeadline: "R",
          bridgeNarrative: "[[wear]] closes.",
          bridgeHeadline: "B",
        },
      };
    };
    const sessionId = useSession();
    await runPipeline(sessionId, () => undefined);
    const rootBefore = narrativeOf("A");
    expect(rootBefore).toBe("root listen opens.");

    await refineBridge(sessionId, "deep_cuts", () => undefined);
    expect(narrativeOf("A")).toBe(rootBefore);
    expect(narrativeOf("B")).toBe("bridge wear closes.");
  });

  it("leaves the pack on the template when the LLM is off", async () => {
    for (const name of ["LLM_PROVIDER", "NEBIUS_API_KEY", "NEBIUS_BASE_URL", "NEBIUS_MODEL", "LLM_MODEL"]) {
      vi.stubEnv(name, "");
    }
    const sessionId = useSession();
    const events: Event[] = [];
    await runPipeline(sessionId, (event) => events.push(event as Event));
    expect(narrativeOf("A")).toBe(ROOTS_TEMPLATE);
    expect(llmOf("A")).toMatchObject({ narrative: "template", provider: null });
    expect(llmOf("A")?.offReason).toContain("missing");
    expect(events.some((event) => event.step === "narrate" && event.status === "done")).toBe(true);
  });
});

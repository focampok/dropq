import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InsightsParams } from "@/lib/qloo/types";

type Row = {
  id: string;
  slot: string;
  position: number;
  hop: number;
  qlooEntityId: string;
  qlooName: string;
  qlooType: string;
  imageUrl: string | null;
  affinityScore: number | null;
  explain: string | null;
  evidence: Record<string, unknown>;
  confidence: string;
  provenance: string;
};

type Pack = {
  id: string;
  label: "A" | "B";
  axis: "root" | "bridge";
  narrative: string | null;
  coverage: Record<string, unknown> | null;
  items: Row[];
};

type Session = {
  id: string;
  city: string;
  locale: string;
  eventKind: "tour";
  seeds: { id: string; rawText: string; resolvedEntityId: string | null; resolvedName: string | null; domain: string }[];
  packs: Pack[];
};

const { state, calls } = vi.hoisted(() => ({
  state: { session: null as Session | null },
  calls: { search: 0, insights: 0, anchors: [] as string[][] },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    session: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.session?.id === where.id ? state.session : null,
    },
    qlooEntityCache: {
      findMany: async () => [],
      upsert: async () => ({}),
    },
    insightCache: {
      findUnique: async () => null,
      upsert: async () => ({}),
    },
    entityTagCache: {
      findMany: async () => [],
      upsert: async () => ({}),
    },
    $transaction: async (fn: (tx: {
      packItem: { deleteMany: (args: { where: { packId: string } }) => Promise<void> };
      pack: { update: (args: { where: { id: string }; data: { narrative: string; coverage: Record<string, unknown>; items: { create: Omit<Row, "id">[] } } }) => Promise<unknown> };
    }) => Promise<unknown>) =>
      fn({
        packItem: {
          deleteMany: async ({ where }: { where: { packId: string } }) => {
            const pack = state.session?.packs.find((item) => item.id === where.packId);
            if (pack) pack.items = [];
          },
        },
        pack: {
          update: async ({ where, data }: { where: { id: string }; data: { narrative: string; coverage: Record<string, unknown>; items?: { create: Omit<Row, "id">[] } } }) => {
            const pack = state.session?.packs.find((item) => item.id === where.id);
            if (!pack) return null;
            pack.narrative = data.narrative;
            pack.coverage = data.coverage;
            pack.items = (data.items?.create ?? []).map((item, index) => ({ id: `written-${index}`, ...item }));
            return pack;
          },
        },
      }),
  },
}));

vi.mock("@/lib/qloo/client", () => ({
  search: async () => {
    calls.search += 1;
    return { provenance: "qloo", results: [] };
  },
  insights: async (args: InsightsParams) => {
    calls.insights += 1;
    if (args.signalInterestsEntities?.length) calls.anchors.push([...args.signalInterestsEntities]);
    const deep = args.filterPopularityMax === 0.9;
    const prefix = deep ? "deep" : "regen";
    const type = args.filterType;
    const slot = type.endsWith(":place")
      ? "do"
      : type.endsWith(":artist")
        ? "listen"
        : type.endsWith(":brand")
          ? "wear"
          : "watch";
    const hit = (id: string) => ({
      entityId: id,
      name: id,
      type,
      imageUrl: null,
      properties: {},
      raw: { tags: [{ name: "Live" }], affinity: 0.4 },
    });
    const results =
      slot === "watch"
        ? [hit(`${prefix}-watch`), hit(`${prefix}-watch-b`), hit(`${prefix}-watch-c`)]
        : [hit(`${prefix}-${slot}`)];
    return { provenance: "qloo", results, raw: {} };
  },
  // The real extractor, inline: the mock replaces the whole client module.
  entityTagNames: (raw: { tags?: { name?: unknown }[] }) =>
    Array.isArray(raw?.tags)
      ? raw.tags.flatMap((tag) => (typeof tag?.name === "string" ? [tag.name] : []))
      : [],
  entitiesByIds: async () => ({ provenance: "qloo", results: [] }),
  qlooQuota: () => ({ blocked: false }),
}));

import { refineBridge } from "@/lib/pipeline/run";

function row(slot: Row["slot"], id: string, evidence: Record<string, unknown>, hop = 0): Row {
  const type =
    slot === "do"
      ? "urn:entity:place"
      : slot === "listen"
        ? "urn:entity:artist"
        : slot === "wear"
          ? "urn:entity:brand"
          : "urn:entity:tv_show";
  return {
    id: `row-${id}`,
    slot,
    position: 0,
    hop,
    qlooEntityId: id,
    qlooName: id,
    qlooType: type,
    imageUrl: slot === "do" ? null : `https://img.example/${id}.jpg`,
    affinityScore: 0.4,
    explain: "Pop",
    evidence,
    confidence: "high",
    provenance: "qloo",
  };
}

function snapshotFrom(items: Row[]) {
  return items.map((item, position) => ({
    slot: item.slot,
    position,
    hop: item.hop,
    entityId: item.qlooEntityId,
    name: item.qlooName,
    type: item.qlooType,
    imageUrl: item.imageUrl,
    affinity: item.affinityScore,
    explain: item.explain,
    evidence: item.evidence,
    confidence: item.confidence,
    provenance: item.provenance,
  }));
}

function pack(label: "A" | "B", items: Row[], coverage: Record<string, unknown> | null): Pack {
  return {
    id: label === "A" ? "pack-a" : "pack-b",
    label,
    axis: label === "A" ? "root" : "bridge",
    narrative: null,
    coverage,
    items,
  };
}

function useSession(root: Row[], bridge: Row[], coverage: Record<string, unknown> | null) {
  state.session = {
    id: "session-1",
    city: "Houston",
    locale: "en",
    eventKind: "tour",
    seeds: [
      { id: "seed-1", rawText: "Bad Bunny", resolvedEntityId: "seed-bb", resolvedName: "Bad Bunny", domain: "artist" },
    ],
    packs: [pack("A", root, { notes: { en: "", es: "" } }), pack("B", bridge, coverage)],
  };
}

function ids(label: "A" | "B"): string[] {
  return state.session?.packs.find((item) => item.label === label)?.items.map((item) => item.qlooEntityId) ?? [];
}

function clientCalls(): number {
  return calls.search + calls.insights;
}

const roots = [
  row("watch", "root-watch", { hitTags: ["Drama"], sharedTagCount: 1 }),
  row("listen", "root-listen", { hitTags: ["Pop"], sharedTagCount: 1 }),
  row("wear", "root-wear", { hitTags: ["Cloth"], sharedTagCount: 1 }),
  row("do", "root-do", { hitTags: ["Live"], sharedTagCount: 0 }),
];

const defaults = [
  row("watch", "def-watch", { hitTags: ["Drama"], sharedTagCount: 2 }, 1),
  row("listen", "def-listen", { hitTags: ["Pop"], sharedTagCount: 2 }, 1),
  row("wear", "def-wear", { hitTags: ["Cloth"], sharedTagCount: 2 }, 1),
  row("do", "def-do", { hitTags: ["Live"], sharedTagCount: 0, chosenByCity: true }, 1),
];

describe("bridge snapshots", () => {
  beforeEach(() => {
    calls.search = 0;
    calls.insights = 0;
    calls.anchors = [];
    state.session = null;
    vi.stubEnv("QLOO_API_KEY", "test-key");
    vi.stubEnv("NEBIUS_API_KEY", "");
    vi.stubEnv("NEBIUS_BASE_URL", "");
    vi.stubEnv("NEBIUS_MODEL", "");
  });

  it("restores the original default after deep cuts with no further client calls", async () => {
    useSession(roots, defaults, {
      notes: { en: "", es: "" },
      mode: "default",
      bridgeMode: "default",
      defaultBridge: snapshotFrom(defaults),
    });
    const rootIds = ids("A");
    const events: { step: string; status: string; detail?: string }[] = [];

    await refineBridge("session-1", "default", (event) => events.push(event));
    expect(clientCalls()).toBe(0);
    expect(ids("B")).toEqual(["def-watch", "def-listen", "def-wear", "def-do"]);
    expect(events.map((event) => [event.step, event.status, event.detail])).toEqual([
      ["pick_bridge_anchors", "skipped", "snapshot"],
      ["insights_hop1", "skipped", "snapshot"],
      ["assemble", "active", undefined],
      ["assemble", "done", undefined],
      ["enrich", "skipped", undefined],
      ["narrate", "done", "B:template"],
      ["done", "done", undefined],
    ]);

    await refineBridge("session-1", "deep_cuts", () => {});
    const afterDeep = clientCalls();
    expect(afterDeep).toBeGreaterThan(0);
    expect(ids("B")).toEqual(["deep-watch", "deep-listen", "deep-wear", "regen-do"]);
    const coverage = state.session?.packs.find((item) => item.label === "B")?.coverage;
    expect(coverage?.bridgeMode).toBe("deep_cuts");
    expect(Array.isArray(coverage?.deepBridge)).toBe(true);
    expect(Array.isArray(coverage?.defaultBridge)).toBe(true);

    await refineBridge("session-1", "default", () => {});
    expect(clientCalls()).toBe(afterDeep);
    expect(ids("B")).toEqual(["def-watch", "def-listen", "def-wear", "def-do"]);
    expect(state.session?.packs.find((item) => item.label === "B")?.items[0]?.imageUrl).toBe(
      "https://img.example/def-watch.jpg",
    );

    await refineBridge("session-1", "deep_cuts", () => {});
    expect(clientCalls()).toBe(afterDeep);
    expect(ids("B")).toEqual(["deep-watch", "deep-listen", "deep-wear", "regen-do"]);

    await refineBridge("session-1", "default", () => {});
    expect(clientCalls()).toBe(afterDeep);
    expect(ids("B")).toEqual(["def-watch", "def-listen", "def-wear", "def-do"]);
    expect(ids("A")).toEqual(rootIds);
    expect(ids("B").some((id) => rootIds.includes(id))).toBe(false);
  });

  it("regenerates a session without a snapshot and then stores it", async () => {
    useSession(roots, [row("listen", "stale-listen", { hitTags: ["Old"] }, 1)], {
      notes: { en: "", es: "" },
      mode: "default",
    });

    await refineBridge("session-1", "default", () => {});
    const spent = clientCalls();
    expect(spent).toBeGreaterThan(0);
    expect(ids("B")).toEqual(["regen-watch", "regen-listen", "regen-wear", "regen-do"]);
    const coverage = state.session?.packs.find((item) => item.label === "B")?.coverage;
    const stored = coverage?.defaultBridge as { entityId: string }[];
    expect(stored.map((item) => item.entityId)).toEqual(ids("B"));
    expect(coverage?.bridgeMode).toBe("default");

    await refineBridge("session-1", "default", () => {});
    expect(clientCalls()).toBe(spent);
    expect(ids("B")).toEqual(["regen-watch", "regen-listen", "regen-wear", "regen-do"]);
  });

  it("ranks anchors by sharedTagCount when hitTags are truncated to 8", async () => {
    const truncated = ["a", "b", "c", "d", "e", "f", "g", "h"];
    useSession(
      [
        row("listen", "listen-high", { hitTags: truncated, sharedTagCount: 12 }),
        row("wear", "wear-low", { hitTags: ["Pop"], sharedTagCount: 1 }),
        row("watch", "watch-trunc", { hitTags: ["Drama"], sharedTagCount: 0 }),
      ],
      [row("listen", "stale", { hitTags: ["Old"] }, 1)],
      { notes: { en: "", es: "" }, mode: "default" },
    );

    await refineBridge("session-1", "default", () => {});
    expect(calls.anchors[0]).toEqual(["listen-high", "wear-low"]);
    expect(calls.anchors[0]).not.toContain("watch-trunc");
  });

  it("drops a root id from a restored bridge", async () => {
    const overlap = snapshotFrom(defaults).map((item) =>
      item.slot === "listen" ? { ...item, entityId: "root-listen", name: "root-listen" } : item,
    );
    useSession(roots, defaults, {
      notes: { en: "", es: "" },
      bridgeMode: "default",
      defaultBridge: overlap,
    });
    const rootIds = ids("A");

    await refineBridge("session-1", "default", () => {});
    expect(ids("B")).toEqual(["def-watch", "def-wear", "def-do"]);
    expect(ids("B")).not.toContain("root-listen");
    expect(ids("A")).toEqual(rootIds);

    await refineBridge("session-1", "default", () => {});
    expect(clientCalls()).toBe(0);
    expect(ids("B")).not.toContain("root-listen");
    expect(ids("A")).toEqual(rootIds);
    expect(ids("B").some((id) => ids("A").includes(id))).toBe(false);
  });
});

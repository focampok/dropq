import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();
const search = vi.fn();
const findTagRows = vi.fn();
const upsertTagRow = vi.fn();
const entitiesByIds = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    qlooEntityCache: { findMany, upsert: vi.fn() },
    insightCache: { findUnique, upsert: vi.fn() },
    entityTagCache: { findMany: findTagRows, upsert: upsertTagRow },
  },
}));

vi.mock("@/lib/qloo/client", () => ({
  search,
  insights: vi.fn(),
  entitiesByIds,
  qlooQuota: () => ({ blocked: false }),
  entityTagNames: (raw: { tags?: { name?: unknown }[] }) =>
    Array.isArray(raw?.tags)
      ? raw.tags.flatMap((tag) => (typeof tag?.name === "string" ? [tag.name] : []))
      : [],
}));

describe("cache-aside", () => {
  beforeEach(() => {
    findMany.mockReset();
    findUnique.mockReset();
    search.mockReset();
    findTagRows.mockReset();
    upsertTagRow.mockReset();
    entitiesByIds.mockReset();
  });

  it("returns a cached search without calling the client", async () => {
    findMany.mockResolvedValue([
      {
        entityId: "id-1",
        type: "urn:entity:artist",
        name: "Bad Bunny",
        metadata: { query: "bad bunny", queryType: "urn:entity:artist", rank: 0, raw: { name: "Bad Bunny" } },
        fetchedAt: new Date(),
      },
    ]);
    const { cachedSearch } = await import("@/lib/qloo/cache");
    const result = await cachedSearch("Bad Bunny", "urn:entity:artist");
    expect(result.results[0]?.entityId).toBe("id-1");
    expect(search).not.toHaveBeenCalled();
  });

  it("builds a seed's reference tags from the entity lookup", async () => {
    findTagRows.mockResolvedValue([]);
    entitiesByIds.mockResolvedValue({
      provenance: "qloo",
      results: [
        {
          entityId: "bb",
          name: "Bad Bunny",
          type: "urn:entity:artist",
          imageUrl: null,
          raw: { tags: [{ name: "Reggaeton" }, { name: "Latin Trap" }, { name: "Energetic" }] },
        },
      ],
    });
    const { cachedEntityTags } = await import("@/lib/qloo/cache");
    const byId = await cachedEntityTags(["bb"]);
    expect(byId.get("bb")).toEqual(["Reggaeton", "Latin Trap", "Energetic"]);
    expect(entitiesByIds).toHaveBeenCalledWith(["bb"]);
    expect(upsertTagRow).toHaveBeenCalledTimes(1);
  });

  it("costs no request when the reference tags are cached", async () => {
    findTagRows.mockResolvedValue([{ entityId: "bb", tags: ["Reggaeton"], fetchedAt: new Date() }]);
    const { cachedEntityTags } = await import("@/lib/qloo/cache");
    const byId = await cachedEntityTags(["bb"]);
    expect(byId.get("bb")).toEqual(["Reggaeton"]);
    expect(entitiesByIds).not.toHaveBeenCalled();
  });

  it("leaves out an id the lookup does not know", async () => {
    findTagRows.mockResolvedValue([]);
    entitiesByIds.mockResolvedValue({ provenance: "qloo", results: [] });
    const { cachedEntityTags } = await import("@/lib/qloo/cache");
    const byId = await cachedEntityTags(["unknown-id"]);
    expect(byId.has("unknown-id")).toBe(false);
  });

  it("returns a cached insight without calling the client", async () => {
    findUnique.mockResolvedValue({
      cacheKey: "abc",
      fetchedAt: new Date(),
      response: { hits: [{ entityId: "hit", name: "Hit", type: "urn:entity:movie", imageUrl: null, properties: {}, raw: {} }], raw: {} },
    });
    const { cachedInsights } = await import("@/lib/qloo/cache");
    const result = await cachedInsights(
      { filterType: "urn:entity:movie" },
      { anchors: ["a"], filterType: "urn:entity:movie", location: "", hop: 0, variant: "a", exclude: [] },
    );
    expect(result.results[0]?.entityId).toBe("hit");
    expect(search).not.toHaveBeenCalled();
  });
});

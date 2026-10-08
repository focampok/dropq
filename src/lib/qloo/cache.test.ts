import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();
const search = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    qlooEntityCache: { findMany, upsert: vi.fn() },
    insightCache: { findUnique, upsert: vi.fn() },
  },
}));

vi.mock("@/lib/qloo/client", () => ({
  search,
  insights: vi.fn(),
  qlooQuota: () => ({ blocked: false }),
}));

describe("cache-aside", () => {
  beforeEach(() => {
    findMany.mockReset();
    findUnique.mockReset();
    search.mockReset();
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

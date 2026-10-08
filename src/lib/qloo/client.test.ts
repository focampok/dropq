import { afterEach, describe, expect, it, vi } from "vitest";
import { resetQlooRuntime, insights, search, tags, analysisCompare } from "@/lib/qloo/client";
import { QlooQuotaError } from "@/lib/qloo/types";

const originalKey = process.env.QLOO_API_KEY;
const originalBase = process.env.QLOO_BASE_URL;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalKey === undefined) delete process.env.QLOO_API_KEY;
  else process.env.QLOO_API_KEY = originalKey;
  if (originalBase === undefined) delete process.env.QLOO_BASE_URL;
  else process.env.QLOO_BASE_URL = originalBase;
  resetQlooRuntime();
});

describe("qloo client", () => {
  it("returns a preset fixture and does not call the network when the key is empty", async () => {
    process.env.QLOO_API_KEY = "";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await search({ query: "  bad bunny " });
    expect(result.provenance).toBe("mock");
    expect(result.results[0]?.entityId).toBe("MOCK:artist:bad-bunny");
    expect(result.results[0]?.type).toBe("urn:entity:artist");
    expect(fetchSpy).not.toHaveBeenCalled();

    const unknown = await search({ query: "not a preset" });
    expect(unknown).toEqual({ provenance: "mock", results: [] });
    expect((await tags({ query: "tour" })).results).toEqual([]);
    expect((await insights({ filterType: "urn:entity:place" })).results).toEqual([]);
    expect((await analysisCompare({ a: ["a"], b: ["b"] })).results).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a host that is not allowlisted", async () => {
    process.env.QLOO_API_KEY = "test-key";
    process.env.QLOO_BASE_URL = "https://evil.example";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(search({ query: "test" })).rejects.toThrow(/allowlisted/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the key as a header and maps insight parameter names", async () => {
    process.env.QLOO_API_KEY = "test-key";
    process.env.QLOO_BASE_URL = "https://hackathon.api.qloo.com";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: { entities: [] } }), { status: 200 }),
    );

    await insights({
      filterType: "urn:entity:artist",
      signalInterestsEntities: ["id-a", "id-b"],
      signalLocationQuery: "Houston",
      filterExcludeEntities: ["id-c"],
      take: 10,
    });

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    const parsed = new URL(String(url));
    expect(parsed.hostname).toBe("hackathon.api.qloo.com");
    expect(parsed.pathname).toBe("/v2/insights");
    expect(parsed.searchParams.get("filter.type")).toBe("urn:entity:artist");
    expect(parsed.searchParams.get("signal.interests.entities")).toBe("id-a,id-b");
    expect(parsed.searchParams.get("signal.location.query")).toBe("Houston");
    expect(parsed.searchParams.get("filter.exclude.entities")).toBe("id-c");
    expect(parsed.searchParams.get("take")).toBe("10");
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Api-Key")).toBe("test-key");
    expect(headers.get("Authorization")).toBeNull();
  });

  it("retries once on HTTP 500", async () => {
    process.env.QLOO_API_KEY = "test-key";
    process.env.QLOO_BASE_URL = "https://hackathon.api.qloo.com";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );

    const result = await search({ query: "test", type: "urn:entity:movie" });
    expect(result.provenance).toBe("qloo");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const parsed = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(parsed.pathname).toBe("/search");
    expect(parsed.searchParams.get("type")).toBe("urn:entity:movie");
  });

  it("never starts a fifth request inside the same second", async () => {
    process.env.QLOO_API_KEY = "test-key";
    process.env.QLOO_BASE_URL = "https://hackathon.api.qloo.com";
    const times: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      times.push(Date.now());
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    await Promise.all(
      Array.from({ length: 5 }, () => search({ query: "q", type: "urn:entity:movie" })),
    );
    expect(times[4]! - times[0]!).toBeGreaterThanOrEqual(1000);
    for (const start of times) {
      const inWindow = times.filter((time) => time >= start && time < start + 1000);
      expect(inWindow.length).toBeLessThanOrEqual(4);
    }
  });

  it("blocks live calls when the monthly remaining header is below 800", async () => {
    process.env.QLOO_API_KEY = "test-key";
    process.env.QLOO_BASE_URL = "https://hackathon.api.qloo.com";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "x-month-ratelimit-remaining": "799" },
      }),
    );
    await search({ query: "q", type: "urn:entity:movie" });
    await expect(search({ query: "q", type: "urn:entity:movie" })).rejects.toBeInstanceOf(QlooQuotaError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

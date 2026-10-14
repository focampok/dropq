import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetQlooRuntime,
  insights,
  search,
  tags,
  analysisCompare,
  acquireQlooSlot,
} from "@/lib/qloo/client";
import { QlooGuardError, QlooQuotaError } from "@/lib/qloo/types";

// Keep the suite hermetic: the real counter talks to Postgres. The pure helpers
// stay real so the guard's arithmetic is still exercised.
vi.mock("@/lib/qloo/usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/qloo/usage")>();
  return {
    ...actual,
    readMonthCount: vi.fn(async () => null),
    countQlooRequest: vi.fn(async () => null),
  };
});

const originalKey = process.env.QLOO_API_KEY;
const originalBase = process.env.QLOO_BASE_URL;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalKey === undefined) delete process.env.QLOO_API_KEY;
  else process.env.QLOO_API_KEY = originalKey;
  if (originalBase === undefined) delete process.env.QLOO_BASE_URL;
  else process.env.QLOO_BASE_URL = originalBase;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  resetQlooRuntime();
});

describe("qloo client", () => {
  it("returns a preset fixture and does not call the network when the key is empty", async () => {
    process.env.NODE_ENV = "test";
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

  it("never returns mock provenance in production when the key is empty", async () => {
    process.env.NODE_ENV = "production";
    process.env.QLOO_API_KEY = "";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(search({ query: "bad bunny" })).rejects.toBeInstanceOf(QlooGuardError);
    await expect(tags({ query: "tour" })).rejects.toBeInstanceOf(QlooGuardError);
    await expect(insights({ filterType: "urn:entity:place" })).rejects.toBeInstanceOf(QlooGuardError);
    await expect(analysisCompare({ a: ["a"], b: ["b"] })).rejects.toBeInstanceOf(QlooGuardError);
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
    // The limiter claims slots synchronously against Date.now(), so the only
    // faithful observation point is that clock. A real clock cannot be used
    // here: any timestamp recorded after an `await` (even one microtask hop) is
    // late by an unbounded scheduler delay, while the fifth call's resume is
    // pinned to a timer, so the measured gap drifts below 1000 ms under load.
    // Fake timers remove the jitter and assert the pacing exactly.
    const starts: number[] = [];
    vi.useFakeTimers();
    try {
      const pending = Promise.all(
        Array.from({ length: 5 }, async () => {
          await acquireQlooSlot();
          starts.push(Date.now());
        }),
      );
      // Flush the four immediate claims, then release the fifth.
      await vi.advanceTimersByTimeAsync(1001);
      await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(starts).toHaveLength(5);
    const first = Math.min(...starts);
    // With the clock frozen the four immediate claims land on one instant and
    // the fifth, held back by the limiter, lands a full window later.
    expect(starts.filter((t) => t === first)).toHaveLength(4);
    expect(Math.max(...starts) - first).toBeGreaterThanOrEqual(1000);
  });

  it("paces five concurrent searches through the slot limiter", async () => {
    process.env.QLOO_API_KEY = "test-key";
    process.env.QLOO_BASE_URL = "https://hackathon.api.qloo.com";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));

    await Promise.all(
      Array.from({ length: 5 }, () => search({ query: "q", type: "urn:entity:movie" })),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(5);
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

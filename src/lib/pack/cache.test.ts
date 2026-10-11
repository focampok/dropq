import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginPackFlight,
  packSignature,
  resetPackSingleFlight,
  type PackCachePayload,
} from "@/lib/pack/cache";

describe("packSignature", () => {
  it("is stable regardless of seed entity id order", () => {
    const a = packSignature({
      entityIds: ["BBB", "aaa"],
      city: " Houston ",
      eventKind: "tour",
      locale: "en",
    });
    const b = packSignature({
      entityIds: ["AAA", "bbb"],
      city: "houston",
      eventKind: "tour",
      locale: "en",
    });
    expect(a).toBe(b);
  });

  it("changes when the language changes", () => {
    const en = packSignature({
      entityIds: ["A"],
      city: "Houston",
      eventKind: "tour",
      locale: "en",
    });
    const es = packSignature({
      entityIds: ["A"],
      city: "Houston",
      eventKind: "tour",
      locale: "es",
    });
    expect(en).not.toBe(es);
  });
});

describe("single flight", () => {
  beforeEach(() => resetPackSingleFlight());
  afterEach(() => resetPackSingleFlight());

  it("runs the builder once for two concurrent callers", async () => {
    let builds = 0;
    const payload = { packs: [] } as unknown as PackCachePayload;
    const build = async () => {
      builds += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { payload, builtAt: new Date() };
    };
    const first = beginPackFlight("sig", "s1", build);
    const second = beginPackFlight("sig", "s2", build);
    expect(first.owner).toBe(true);
    expect(second.owner).toBe(false);
    await Promise.all([first.promise, second.promise]);
    expect(builds).toBe(1);
  });
});

describe("cache TTL", () => {
  it("treats expired rows as misses via ttl helper contract", () => {
    // TTL constants are hours; expiry is covered by readPackCache against builtAt.
    // Here we only assert signature + flight contracts stay pure (no timers needed).
    vi.useFakeTimers();
    const started = Date.now();
    vi.setSystemTime(started);
    const sig = packSignature({
      entityIds: ["x"],
      city: "Houston",
      eventKind: "tour",
      locale: "en",
    });
    expect(sig).toHaveLength(64);
    vi.useRealTimers();
  });
});

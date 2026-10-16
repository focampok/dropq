import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginBaselineFlight, resetBaselineSingleFlight } from "@/lib/baseline/cache";
import { packEntityIdsBySlot, summarize, validateBaseline } from "@/lib/baseline/validate";
import { verifyBaselineItems } from "@/lib/baseline/resolve";
import { baselineSignature } from "@/lib/baseline/signature";
import type { BaselinePayload } from "@/lib/baseline/types";
import { BASELINE_SLOTS } from "@/lib/baseline/types";

vi.mock("@/lib/qloo/client", () => {
  let calls = 0;
  return {
    observedQlooCalls: () => calls,
    search: vi.fn(async ({ query, type }: { query: string; type?: string }) => {
      calls += 1;
      if (query === "none") return { provenance: "qloo", results: [] };
      if (query === "boom") throw new Error("search_failed");
      return {
        provenance: "qloo",
        results: [{ entityId: `id-${query}`, name: query, type: type ?? "urn:entity:artist" }],
      };
    }),
  };
});

function payload(overrides?: Partial<BaselinePayload>): BaselinePayload {
  const llmItems = BASELINE_SLOTS.map((slot) => ({ slot, name: `Name ${slot}` }));
  const verification = BASELINE_SLOTS.map((slot) => ({
    slot,
    status: "verified" as const,
    resolvedEntityId: `id-${slot}`,
    resolvedName: `Name ${slot}`,
    inPack: slot === "watch",
  }));
  return {
    cardsSig: "cards",
    locale: "en",
    llmItems,
    verification,
    source: "llm",
    summary: summarize(verification),
    ...overrides,
  };
}

describe("baseline validate", () => {
  it("accepts a well-formed payload", () => {
    expect(validateBaseline(payload())).toEqual({ ok: true });
  });

  it("rejects a malformed baseline", () => {
    const bad = payload();
    bad.llmItems = bad.llmItems.slice(0, 3);
    expect(validateBaseline(bad)).toMatchObject({ ok: false, rule: "item_count" });
  });

  it("rejects inPack that does not match the real pack", () => {
    const packIds = packEntityIdsBySlot([
      { label: "A", items: [{ slot: "watch", qlooEntityId: "other" }] },
      { label: "B", items: [] },
    ]);
    expect(validateBaseline(payload(), packIds)).toMatchObject({ ok: false, rule: "in_pack_mismatch" });
  });
});

describe("baseline resolve", () => {
  it("uses at most four Qloo searches and marks unverifiable paths", async () => {
    const { search, observedQlooCalls } = await import("@/lib/qloo/client");
    const before = observedQlooCalls();
    const { verification, qlooCalls } = await verifyBaselineItems(
      [
        { slot: "watch", name: "Show" },
        { slot: "listen", name: "none" },
        { slot: "wear", name: "boom" },
        { slot: "do", name: "Venue" },
      ],
      { watch: new Set(["ID-SHOW"]), do: new Set(["ID-VENUE"]) },
    );
    expect(qlooCalls).toBeLessThanOrEqual(4);
    expect(observedQlooCalls() - before).toBeLessThanOrEqual(4);
    expect(verification.find((row) => row.slot === "watch")).toMatchObject({
      status: "verified",
      inPack: true,
    });
    expect(verification.find((row) => row.slot === "listen")?.status).toBe("not_verifiable");
    expect(verification.find((row) => row.slot === "wear")?.reason).toBe("search_error");
    expect(vi.mocked(search).mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe("baseline single-flight", () => {
  beforeEach(() => resetBaselineSingleFlight());
  afterEach(() => resetBaselineSingleFlight());

  it("runs the builder once for concurrent callers", async () => {
    let builds = 0;
    const build = async () => {
      builds += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { payload: payload(), builtAt: new Date() };
    };
    const first = beginBaselineFlight("sig", build);
    const second = beginBaselineFlight("sig", build);
    expect(first.owner).toBe(true);
    expect(second.owner).toBe(false);
    await Promise.all([first.promise, second.promise]);
    expect(builds).toBe(1);
  });
});

describe("baseline signature", () => {
  it("differs by language and shares cardsSig", () => {
    const en = baselineSignature({
      entityIds: ["a"],
      city: "Houston",
      eventKind: "tour",
      locale: "en",
    });
    const es = baselineSignature({
      entityIds: ["a"],
      city: "Houston",
      eventKind: "tour",
      locale: "es",
    });
    expect(en.cardsSig).toBe(es.cardsSig);
    expect(en.signature).not.toBe(es.signature);
  });
});

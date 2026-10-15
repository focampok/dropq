import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginPackFlight,
  narrationGradeReplaces,
  packNarrationGrade,
  packSignature,
  resetPackSingleFlight,
  stampCacheNarration,
  type PackCachePayload,
} from "@/lib/pack/cache";
import { PIPELINE_VERSION } from "@/lib/pipeline/config";

function slotItem(
  slot: "watch" | "listen" | "wear" | "do",
  id: string,
): PackCachePayload["packs"][number]["items"][number] {
  const meta = {
    watch: { name: "Show", type: "urn:entity:tv_show", tags: ["Drama"] },
    listen: { name: "Artist", type: "urn:entity:artist", tags: ["Pop"] },
    wear: { name: "Puma", type: "urn:entity:brand", tags: ["Apparel"] },
    do: { name: "Venue", type: "urn:entity:place", tags: ["Nightlife"] },
  }[slot];
  return {
    slot,
    position: 0,
    hop: 0,
    qlooEntityId: id,
    qlooName: meta.name,
    qlooType: meta.type,
    imageUrl: null,
    affinityScore: null,
    explain: null,
    evidence: { hitTags: meta.tags, sharedTags: [] },
    confidence: "medium",
    provenance: "qloo",
  };
}

function payloadWith(narrativeA: "llm" | "template", narrativeB: "llm" | "template"): PackCachePayload {
  const items = (prefix: string) =>
    (["watch", "listen", "wear", "do"] as const).map((slot) => slotItem(slot, `${prefix}-${slot}`));
  return {
    city: "Houston",
    eventKind: "tour",
    locale: "en",
    seeds: [
      { rawText: "Bad Bunny", source: "preset", resolvedEntityId: "s1", resolvedName: "Bad Bunny", domain: "artist" },
      { rawText: "Karol G", source: "preset", resolvedEntityId: "s2", resolvedName: "Karol G", domain: "artist" },
      { rawText: "Nike", source: "preset", resolvedEntityId: "s3", resolvedName: "Nike", domain: "brand" },
    ],
    packs: [
      {
        label: "A",
        axis: "root",
        narrative: "Tonight with Artist.",
        coverage: { llm: { narrative: narrativeA, modelUsed: { narrative: narrativeA === "llm" ? "m1" : null } } },
        items: items("a"),
      },
      {
        label: "B",
        axis: "bridge",
        narrative: "Bridge with Puma.",
        coverage: { llm: { narrative: narrativeB, modelUsed: { narrative: narrativeB === "llm" ? "m1" : null } } },
        items: items("b"),
      },
    ],
  };
}

describe("packSignature", () => {
  it("changes when the pipeline version changes", () => {
    const base = { entityIds: ["BBB"], city: "Houston", eventKind: "tour", locale: "en" };
    expect(packSignature({ ...base, pipelineVersion: "3h" })).not.toBe(
      packSignature({ ...base, pipelineVersion: "3i" }),
    );
    // The default is the version the pipeline currently builds with, so an old row is a miss.
    expect(packSignature(base)).toBe(packSignature({ ...base, pipelineVersion: PIPELINE_VERSION }));
  });


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
  it("serves expired presets and hard-misses expired ordinary packs", async () => {
    const staleBuiltAt = new Date("2020-01-01T00:00:00.000Z");
    const payload = payloadWith("llm", "llm");
    const findUnique = vi.fn();
    vi.doMock("@/lib/db", () => ({
      prisma: { packCache: { findUnique, upsert: vi.fn() } },
    }));
    vi.resetModules();
    const { readPackCache, packCacheExpired } = await import("@/lib/pack/cache");

    expect(packCacheExpired(staleBuiltAt, true, Date.parse("2026-10-12T00:00:00.000Z"))).toBe(true);
    expect(packCacheExpired(staleBuiltAt, false, Date.parse("2026-10-12T00:00:00.000Z"))).toBe(true);

    findUnique.mockResolvedValueOnce({
      signature: "sig-preset",
      payload,
      builtAt: staleBuiltAt,
      qlooCalls: 0,
      isPreset: true,
    });
    const presetHit = await readPackCache("sig-preset");
    expect(presetHit).not.toBeNull();
    expect(presetHit?.isPreset).toBe(true);
    expect(presetHit?.builtAt).toEqual(staleBuiltAt);

    findUnique.mockResolvedValueOnce({
      signature: "sig-custom",
      payload,
      builtAt: staleBuiltAt,
      qlooCalls: 0,
      isPreset: false,
    });
    expect(await readPackCache("sig-custom")).toBeNull();

    findUnique.mockResolvedValueOnce(null);
    expect(await readPackCache("sig-missing")).toBeNull();

    vi.doUnmock("@/lib/db");
    vi.resetModules();
  });
});

describe("narration grade / overwrite rule", () => {
  it("grades llm only when every plan is llm", () => {
    expect(packNarrationGrade(payloadWith("llm", "llm"))).toBe("llm");
    expect(packNarrationGrade(payloadWith("llm", "template"))).toBe("template");
    expect(packNarrationGrade(payloadWith("template", "template"))).toBe("template");
  });

  it("lets llm replace template and equal grades replace; never template over llm", () => {
    expect(narrationGradeReplaces("llm", "template")).toBe(true);
    expect(narrationGradeReplaces("llm", "llm")).toBe(true);
    expect(narrationGradeReplaces("template", "template")).toBe(true);
    expect(narrationGradeReplaces("template", "llm")).toBe(false);
  });

  it("stamps coverage.cache.narration without dropping llm coverage", () => {
    const stamped = stampCacheNarration(payloadWith("llm", "llm"), "llm");
    for (const pack of stamped.packs) {
      const coverage = pack.coverage as { cache?: { narration?: string }; llm?: { narrative?: string } };
      expect(coverage.cache?.narration).toBe("llm");
      expect(coverage.llm?.narrative).toBe("llm");
    }
  });

  it("writePackCacheIfBetter keeps an llm row when the candidate is template", async () => {
    const builtAt = new Date("2026-10-11T00:00:00.000Z");
    const findUnique = vi.fn(async () => ({
      signature: "sig",
      payload: payloadWith("llm", "llm"),
      builtAt,
      qlooCalls: 0,
      isPreset: true,
    }));
    const upsert = vi.fn();
    vi.doMock("@/lib/db", () => ({ prisma: { packCache: { findUnique, upsert } } }));
    vi.resetModules();
    const { writePackCacheIfBetter } = await import("@/lib/pack/cache");
    const result = await writePackCacheIfBetter({
      signature: "sig",
      payload: payloadWith("template", "template"),
      qlooCalls: 1,
      isPreset: true,
    });
    expect(result).toEqual({ wrote: false, builtAt, grade: "llm" });
    expect(upsert).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/db");
    vi.resetModules();
  });
});

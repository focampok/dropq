import { describe, expect, it } from "vitest";
import { evaluateWarmCheck } from "./warm-presets";
import type { PackCachePayload } from "../src/lib/pack/cache";

function payload(narrative: "llm" | "template"): PackCachePayload {
  return {
    city: "Houston",
    eventKind: "tour",
    locale: "en",
    seeds: [],
    packs: [
      {
        label: "A",
        axis: "root",
        narrative: "a",
        coverage: { llm: { narrative, modelUsed: { narrative: narrative === "llm" ? "m" : null } } },
        items: [],
      },
      {
        label: "B",
        axis: "bridge",
        narrative: "b",
        coverage: { llm: { narrative, modelUsed: { narrative: narrative === "llm" ? "m" : null } } },
        items: [],
      },
    ],
  };
}

describe("warm --check", () => {
  it("fails missing, template, and stale rows", () => {
    expect(
      evaluateWarmCheck({ presetId: "p", locale: "en", row: null }).reason,
    ).toBe("missing");

    const template = evaluateWarmCheck({
      presetId: "p",
      locale: "en",
      row: { payload: payload("template"), builtAt: new Date() },
    });
    expect(template.ok).toBe(false);
    expect(template.reason).toBe("template");
    expect(template.narration).toEqual({ A: "template", B: "template" });

    const stale = evaluateWarmCheck({
      presetId: "p",
      locale: "en",
      row: { payload: payload("llm"), builtAt: new Date("2020-01-01T00:00:00.000Z") },
      nowMs: Date.parse("2026-10-12T00:00:00.000Z"),
      ttlHours: 72,
    });
    expect(stale.ok).toBe(false);
    expect(stale.reason).toBe("stale");

    const ok = evaluateWarmCheck({
      presetId: "p",
      locale: "en",
      row: { payload: payload("llm"), builtAt: new Date() },
      ttlHours: 72,
    });
    expect(ok.ok).toBe(true);
    expect(ok.reason).toBeUndefined();
    expect(ok.modelUsed).toEqual({ A: "m", B: "m" });
  });
});

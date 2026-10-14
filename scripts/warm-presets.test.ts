import { describe, expect, it, vi } from "vitest";
import {
  databaseTarget,
  evaluateWarmCheck,
  formatWarmRowLine,
  LOCALES,
  REMOTE_FLAG,
  requiresRemoteConfirmation,
  warmTargets,
} from "./warm-presets";
import type { PackCachePayload } from "../src/lib/pack/cache";
import { PINNED_PRESETS } from "../src/lib/pipeline/config";

function payload(narrative: "llm" | "template", locale: "en" | "es" = "en"): PackCachePayload {
  return {
    city: "Houston",
    eventKind: "tour",
    locale,
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

describe("warm remote guard", () => {
  it("classifies the target by host only", () => {
    expect(databaseTarget("postgresql://u:p@localhost:5432/db")).toBe("local");
    expect(databaseTarget("postgresql://u:p@127.0.0.1:5432/db")).toBe("local");
    expect(databaseTarget("postgresql://u:p@[::1]:5432/db")).toBe("local");
    expect(databaseTarget("postgresql://u:p@db.example.internal:5432/db")).toBe("remote");
    expect(databaseTarget("postgresql://u:p@10.0.0.9:5432/db")).toBe("remote");
    expect(databaseTarget("")).toBe("missing");
    expect(databaseTarget("   ")).toBe("missing");
  });

  it("falls back to DATABASE_URL when no URL is given", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.internal:5432/db");
    expect(databaseTarget()).toBe("remote");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/db");
    expect(databaseTarget()).toBe("local");
    vi.stubEnv("DATABASE_URL", "");
    expect(databaseTarget()).toBe("missing");
    vi.unstubAllEnvs();
  });

  it("treats an unparseable URL as remote rather than assuming local", () => {
    expect(databaseTarget("not a url")).toBe("remote");
    expect(databaseTarget("postgresql://")).toBe("remote");
  });

  it("requires the flag for a remote target, on every run", () => {
    expect(requiresRemoteConfirmation("remote", ["node", "warm"])).toBe(true);
    expect(requiresRemoteConfirmation("remote", ["node", "warm", "--check"])).toBe(true);
    expect(requiresRemoteConfirmation("remote", ["node", "warm", REMOTE_FLAG])).toBe(false);
    // A local target never needs it.
    expect(requiresRemoteConfirmation("local", ["node", "warm"])).toBe(false);
  });
});

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

  it("accepts a Spanish llm row the same way as English", () => {
    const es = evaluateWarmCheck({
      presetId: "roots-gt-la",
      locale: "es",
      row: { payload: payload("llm", "es"), builtAt: new Date() },
      ttlHours: 72,
    });
    expect(es.ok).toBe(true);
    expect(es.locale).toBe("es");
    expect(es.narration).toEqual({ A: "llm", B: "llm" });
    expect(es.modelUsed).toEqual({ A: "m", B: "m" });

    const missingEs = evaluateWarmCheck({
      presetId: "roots-gt-la",
      locale: "es",
      row: null,
    });
    expect(missingEs.ok).toBe(false);
    expect(missingEs.reason).toBe("missing");
  });

  it("plans all six preset×locale rows and formats the report line", () => {
    const targets = warmTargets();
    expect(LOCALES).toEqual(["en", "es"]);
    expect(targets).toHaveLength(PINNED_PRESETS.length * LOCALES.length);
    expect(targets).toHaveLength(6);
    expect(targets.filter((row) => row.locale === "es")).toHaveLength(3);
    expect(targets.filter((row) => row.locale === "en")).toHaveLength(3);
    expect(new Set(targets.map((row) => row.presetId)).size).toBe(3);

    const line = formatWarmRowLine({
      presetId: "roots-gt-la",
      locale: "es",
      status: "cached",
      narration: { A: "llm", B: "llm" },
      modelUsed: { A: "gemini-3.1-flash-lite", B: "gemini-3.1-flash-lite" },
      geminiCalls: 2,
      qlooCalls: 0,
    });
    expect(line).toContain("roots-gt-la");
    expect(line).toContain("es");
    expect(line).toContain("A=llm");
    expect(line).toContain("B=llm");
    expect(line).toContain("modelA=gemini-3.1-flash-lite");
    expect(line).toContain("gemini=2");
  });
});

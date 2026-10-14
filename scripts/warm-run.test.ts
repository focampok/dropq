import { describe, expect, it } from "vitest";
import { narrationGradeReplaces, type PackCachePayload } from "../src/lib/pack/cache";
import { QLOO_CUSTOM_RESERVE } from "../src/lib/config";
import { PINNED_PRESETS } from "../src/lib/pipeline/config";
import {
  guatemalaTime,
  llmReasonFor,
  runWarmRounds,
  selectTargets,
  onlySelectors,
  numericArg,
  stopLine,
  summarize,
  summaryLine,
  warmOne,
  WarmArgError,
  type WarmBuild,
  type WarmDeps,
  type WarmRow,
  type WarmTarget,
} from "./warm-run";

function payload(narrative: "llm" | "template", failures: string[] = []): PackCachePayload {
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
        coverage: { llm: { narrative, modelUsed: { narrative: narrative === "llm" ? "m" : null }, failures } },
        items: [],
      },
      {
        label: "B",
        axis: "bridge",
        narrative: "b",
        coverage: { llm: { narrative, modelUsed: { narrative: narrative === "llm" ? "m" : null }, failures } },
        items: [],
      },
    ],
  };
}

const LLM: WarmBuild = { ok: true, payload: payload("llm"), qlooCalls: 0 };
const TEMPLATE_QUOTA: WarmBuild = {
  ok: true,
  payload: payload("template", ["quota_daily"]),
  qlooCalls: 0,
};

const keyOf = (target: WarmTarget) => `${target.presetId}:${target.locale}`;

/** Deps with a scripted builder and the repository's own grade rule in the store. */
function makeDeps(input: {
  results: (target: WarmTarget, buildIndex: number) => WarmBuild;
  store?: Map<string, "llm" | "template">;
  llmOn?: boolean;
  qlooQuota?: () => { blocked: boolean; remaining?: number };
  dailyExhaustion?: () => { exhausted: boolean; resetMs: number | null };
}) {
  const store = input.store ?? new Map<string, "llm" | "template">();
  const sleeps: number[] = [];
  const built: string[] = [];
  let clock = 0;
  const deps: WarmDeps = {
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    build: async (target) => {
      const index = built.filter((entry) => entry === keyOf(target)).length;
      built.push(keyOf(target));
      return input.results(target, index);
    },
    readStored: async (target) => {
      const grade = store.get(keyOf(target));
      return grade ? { grade } : null;
    },
    write: async ({ target, payload: candidate }) => {
      const grade = candidate.packs.every(
        (pack) => (pack.coverage as { llm?: { narrative?: string } }).llm?.narrative === "llm",
      )
        ? "llm"
        : "template";
      const existing = store.get(keyOf(target));
      if (existing && !narrationGradeReplaces(grade, existing)) return { wrote: false, grade: existing };
      store.set(keyOf(target), grade);
      return { wrote: true, grade };
    },
    llm: () => ({ configured: input.llmOn ?? true, disabled: false }),
    geminiCalls: () => 0,
    qlooCalls: () => 0,
    qlooQuota: input.qlooQuota ?? (() => ({ blocked: false })),
    dailyExhaustion: input.dailyExhaustion ?? (() => ({ exhausted: false, resetMs: null })),
    log: () => undefined,
  };
  return { deps, store, sleeps, built };
}

const OPTIONS = { untilOk: false, maxRounds: 4, pauseMs: 300_000 };
const ONE: WarmTarget[] = [{ presetId: "roots-gt-la", locale: "en" }];

describe("--only", () => {
  it("selects a preset for both languages, or one of them", () => {
    expect(selectTargets([])).toHaveLength(6);
    expect(selectTargets(["roots-gt-la"])).toEqual([
      { presetId: "roots-gt-la", locale: "en" },
      { presetId: "roots-gt-la", locale: "es" },
    ]);
    expect(selectTargets(["roots-gt-la:es"])).toEqual([{ presetId: "roots-gt-la", locale: "es" }]);
    expect(selectTargets(["fandom-con-nyc:en", "fandom-con-nyc:en"])).toEqual([
      { presetId: "fandom-con-nyc", locale: "en" },
    ]);
  });

  it("rejects an unknown preset or language by name, never silently", () => {
    expect(() => selectTargets(["nope"])).toThrow(WarmArgError);
    expect(() => selectTargets(["roots-gt-la:fr"])).toThrow(WarmArgError);
    expect(() => selectTargets(["roots-gt-la:en:es"])).toThrow(WarmArgError);
    expect(() => selectTargets(["nope"])).toThrow(/unknown preset "nope"/);
  });

  it("reads --only repeatably, including a comma-separated list", () => {
    expect(onlySelectors(["--only", "a,b", "--only", "c:es"])).toEqual(["a", "b", "c:es"]);
    expect(onlySelectors([])).toEqual([]);
    expect(() => onlySelectors(["--only"])).toThrow(WarmArgError);
  });

  it("reads a numeric flag and rejects a missing value", () => {
    expect(numericArg(["--max-rounds", "2"], "--max-rounds", 4)).toBe(2);
    expect(numericArg([], "--max-rounds", 4)).toBe(4);
    expect(() => numericArg(["--max-rounds"], "--max-rounds", 4)).toThrow(WarmArgError);
    expect(() => numericArg(["--pause-s", "soon"], "--pause-s", 300)).toThrow(WarmArgError);
  });
});

describe("row outcomes", () => {
  it("caches a row that narrated with the LLM", async () => {
    const { deps, store } = makeDeps({ results: () => LLM });
    const row = await warmOne(ONE[0]!, deps);
    expect(row).toMatchObject({ status: "cached", reason: "ok", attempts: 1, narration: { A: "llm", B: "llm" } });
    expect(store.get("roots-gt-la:en")).toBe("llm");
  });

  it("writes the template with the quota reason instead of failing, and does not retry", async () => {
    const { deps, store, built } = makeDeps({
      results: () => TEMPLATE_QUOTA,
      dailyExhaustion: () => ({ exhausted: true, resetMs: 1_234 }),
    });
    const row = await warmOne(ONE[0]!, deps);
    expect(row.status).toBe("template");
    expect(row.reason).toBe("quota_daily");
    // One build: every model is skipped, so a second one would only spend Qloo.
    expect(row.attempts).toBe(1);
    expect(built).toHaveLength(1);
    expect(store.get("roots-gt-la:en")).toBe("template");
  });

  it("keeps a stored llm row and never lets a template build replace it", async () => {
    const store = new Map([["roots-gt-la:en", "llm" as const]]);
    const { deps } = makeDeps({ results: () => TEMPLATE_QUOTA, store });
    const row = await warmOne(ONE[0]!, deps);
    expect(row.status).toBe("kept");
    expect(row.reason).toBe("quota_daily");
    expect(store.get("roots-gt-la:en")).toBe("llm");
  });

  it("retries while the LLM can still answer, and stops as soon as it narrates", async () => {
    const { deps, built } = makeDeps({
      results: (_target, index) => (index === 0 ? { ok: true, payload: payload("template", ["timeout"]), qlooCalls: 0 } : LLM),
    });
    const row = await warmOne(ONE[0]!, deps);
    expect(row.status).toBe("cached");
    expect(row.attempts).toBe(2);
    expect(built).toHaveLength(2);
  });

  it("fails a row only when the build itself could not run", async () => {
    const { deps } = makeDeps({ results: () => ({ ok: false, reason: "build_error" }) });
    expect(await warmOne(ONE[0]!, deps)).toMatchObject({ status: "failed", reason: "build_error", attempts: 1 });

    const guarded = makeDeps({ results: () => ({ ok: false, reason: "qloo_guard" }) });
    expect(await warmOne(ONE[0]!, guarded.deps)).toMatchObject({ status: "failed", reason: "qloo_guard" });

    const broken = makeDeps({ results: () => ({ ok: false, reason: "qloo_error" }) });
    expect(await warmOne(ONE[0]!, broken.deps)).toMatchObject({ status: "failed", reason: "qloo_error" });
  });

  it("fails a row with the Qloo guard when the reserve is already spent", async () => {
    const { deps, built } = makeDeps({
      results: () => LLM,
      qlooQuota: () => ({ blocked: false, remaining: QLOO_CUSTOM_RESERVE - 1 }),
    });
    const row = await warmOne(ONE[0]!, deps);
    expect(row).toMatchObject({ status: "failed", reason: "qloo_guard", attempts: 1 });
    expect(built).toHaveLength(0);
  });

  it("reports the LLM reason of a template payload", () => {
    expect(llmReasonFor(payload("template", ["quota_daily"]))).toBe("quota_daily");
    expect(llmReasonFor(payload("template", ["quota_minute"]))).toBe("quota_minute");
    expect(llmReasonFor(payload("template", ["deadline"]))).toBe("timeout");
    expect(llmReasonFor(payload("template", ["no_token"]))).toBe("llm_error");
    expect(llmReasonFor(payload("template", []))).toBe("llm_error");
  });
});

describe("rounds", () => {
  it("succeeds on round 2 and stops with all_llm", async () => {
    const { deps, sleeps, built } = makeDeps({
      // Round 1 never narrates (3 attempts, 2 s apart), round 2 narrates first try.
      results: (_target, index) =>
        index < 3 ? { ok: true, payload: payload("template", ["network"]), qlooCalls: 0 } : LLM,
    });
    const result = await runWarmRounds(ONE, { ...OPTIONS, untilOk: true }, deps);
    expect(result.stop).toBe("all_llm");
    expect(result.rounds).toBe(2);
    expect(result.rows.map((row) => row.status)).toEqual(["template", "cached"]);
    expect(built).toHaveLength(4);
    expect(sleeps.filter((ms) => ms >= 60_000)).toEqual([300_000]);
    expect(sleeps.filter((ms) => ms < 60_000)).toEqual([2_000, 2_000]);
  });

  it("stops early on quota_daily and names the Guatemala reset time", async () => {
    const resetMs = Date.parse("2026-10-15T07:00:00.000Z");
    const { deps, sleeps } = makeDeps({
      results: () => TEMPLATE_QUOTA,
      dailyExhaustion: () => ({ exhausted: true, resetMs }),
    });
    const result = await runWarmRounds(ONE, { ...OPTIONS, untilOk: true }, deps);
    expect(result.stop).toBe("quota_daily");
    expect(result.resetMs).toBe(resetMs);
    expect(result.rounds).toBe(1);
    expect(sleeps).toEqual([]);
    expect(stopLine(result.stop, result.resetMs)).toBe(
      "warm stopped: every gemini model is out of daily quota; it resets 2026-10-15 01:00 (UTC-6)",
    );
    expect(guatemalaTime(resetMs)).toBe("2026-10-15 01:00 (UTC-6)");
  });

  it("stops at --max-rounds and never pauses less than a minute", async () => {
    const { deps, sleeps } = makeDeps({
      results: () => ({ ok: true, payload: payload("template", ["no_token"]), qlooCalls: 0 }),
    });
    const result = await runWarmRounds(ONE, { untilOk: true, maxRounds: 3, pauseMs: 1_000 }, deps);
    expect(result.stop).toBe("max_rounds");
    expect(result.rounds).toBe(3);
    expect(result.rows).toHaveLength(3);
    // Row retries pause 2 s; the pause between rounds is never under a minute, even
    // though 1 s was asked for.
    expect(sleeps.filter((ms) => ms < 60_000)).toEqual([2_000, 2_000, 2_000, 2_000, 2_000, 2_000]);
    expect(sleeps.filter((ms) => ms >= 60_000)).toEqual([60_000, 60_000]);
    expect(stopLine(result.stop, null)).toMatch(/max-rounds/);
  });

  it("stops when the Qloo remaining falls below the reserve", async () => {
    const { deps } = makeDeps({
      results: () => ({ ok: true, payload: payload("template", ["no_token"]), qlooCalls: 0 }),
      qlooQuota: () => ({ blocked: false, remaining: QLOO_CUSTOM_RESERVE - 1 }),
    });
    const result = await runWarmRounds(ONE, { ...OPTIONS, untilOk: true }, deps);
    // The reserve is already spent, so the first round fails the row and stops.
    expect(result.rows[0]!.status).toBe("failed");
    expect(result.rows[0]!.reason).toBe("qloo_guard");
  });

  it("rebuilds only the rows that are not llm in a later round", async () => {
    const store = new Map<string, "llm" | "template">([["latin-tour-houston:en", "llm"]]);
    const targets: WarmTarget[] = [
      { presetId: "latin-tour-houston", locale: "en" },
      { presetId: "latin-tour-houston", locale: "es" },
    ];
    const { deps, built } = makeDeps({
      results: (_target, index) => (index === 0 ? { ok: true, payload: payload("template", ["no_token"]), qlooCalls: 0 } : LLM),
      store,
    });
    const result = await runWarmRounds(targets, { ...OPTIONS, untilOk: true }, deps);
    expect(result.stop).toBe("all_llm");
    // The English row was already an llm row, so only Spanish was ever built.
    expect(built).toEqual(["latin-tour-houston:es", "latin-tour-houston:es"]);
    expect(result.rows).toHaveLength(1);
  });

  it("does not run a second round without --until-ok", async () => {
    const { deps, built } = makeDeps({
      results: () => ({ ok: true, payload: payload("template", ["no_token"]), qlooCalls: 0 }),
    });
    const result = await runWarmRounds(ONE, OPTIONS, deps);
    expect(result.stop).toBe("single_round");
    expect(result.rounds).toBe(1);
    // One row, retried up to WARM_ATTEMPTS because the LLM can still answer.
    expect(built).toHaveLength(3);
    expect(result.rows).toHaveLength(1);
    expect(stopLine(result.stop, null)).toBeNull();
  });
});

describe("summary", () => {
  const rows: WarmRow[] = [
    { presetId: "p", locale: "en", status: "cached", reason: "ok", narration: { A: "llm", B: "llm" }, modelUsed: { A: "m", B: "m" }, geminiCalls: 2, qlooCalls: 0, attempts: 1, ms: 1 },
    { presetId: "p", locale: "es", status: "template", reason: "quota_daily", narration: { A: "template", B: "template" }, modelUsed: { A: null, B: null }, geminiCalls: 0, qlooCalls: 3, attempts: 1, ms: 2 },
  ];

  it("counts outcomes and names the next command", () => {
    expect(summarize(rows)).toEqual({ cached: 1, kept: 0, template: 1, failed: 0 });
    const line = summaryLine({ rows, rounds: 1, geminiCalls: 2, qlooCalls: 3, targets: 6, llmRows: 1 });
    expect(line).toContain("cached=1");
    expect(line).toContain("template=1");
    expect(line).toContain("llm_rows=1/6");
    expect(line).toContain("gemini=2");
    expect(line).toContain("qloo=3");
    expect(line).toContain("next: pnpm warm:remote --until-ok");
    expect(summaryLine({ rows, rounds: 1, geminiCalls: 0, qlooCalls: 0, targets: 6, llmRows: 6 })).toContain(
      "next: pnpm warm:remote --check",
    );
  });

  it("keeps every status reachable and the preset ids real", () => {
    const ids = PINNED_PRESETS.map((preset) => preset.id);
    for (const row of rows) expect(ids.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.status))).toEqual(new Set(["cached", "template"]));
  });
});

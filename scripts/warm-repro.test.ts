/**
 * The warm against a real database and a mocked model, in a scratch schema of its own.
 *
 * This is the reproduction of the instant `failed` rows: every Gemini call after the
 * first few answers 429 `per_day`, exactly as the two dead fallback models of the real
 * chain do. A row must then be written with the template narration and a `reason=` that
 * names the quota — never `failed` — and the exhausted models must not be called again
 * on the next row.
 *
 * It needs a reachable Postgres: it creates `dropq_warm_repro`, applies the Prisma schema
 * there with `prisma db push`, and drops it again in the end. `DATABASE_URL` comes from
 * `.env` and is only ever used to derive that scratch URL; without a database the suite
 * is skipped rather than failed. The schema name is fixed and separate, so the database
 * the app uses is never touched.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

if (existsSync(".env")) loadEnvFile(".env");

const SCRATCH_SCHEMA = "dropq_warm_repro";

/** The scratch URL, or null when there is no usable database to talk to. */
function scratchUrl(): string | null {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!/^postgres(ql)?:$/.test(url.protocol)) return null;
    url.searchParams.set("schema", SCRATCH_SCHEMA);
    return url.toString();
  } catch {
    return null;
  }
}

const SCRATCH = scratchUrl();

/**
 * State the mocked transport reads: how many calls still answer before the daily 429,
 * and whether the current round answers with a narration the validator accepts.
 */
const llm = vi.hoisted(() => ({ calls: 0, healthy: 0, valid: true }));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    generateObject: async (args: { prompt: string }) => {
      llm.calls += 1;
      if (llm.calls > llm.healthy) {
        throw Object.assign(new Error("Resource exhausted"), {
          statusCode: 429,
          responseBody: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
        });
      }
      return { object: objectFor(args.prompt, llm.valid), usage: {} };
    },
  };
});

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => (modelId: string) => ({ modelId, provider: "google" }),
}));

/** Qloo, from fixtures: no network, and the same shapes the pipeline reads. */
vi.mock("@/lib/qloo/cache", () => ({
  cachedSearch: async (query: string) => ({
    provenance: "qloo",
    results: [
      {
        entityId: `MOCK:seed:${query.replace(/\s+/g, "-").toLowerCase()}`,
        name: query,
        type: "urn:entity:artist",
        imageUrl: null,
        raw: { entity_id: "x", name: query, tags: [{ name: "Shared Tag" }] },
      },
    ],
  }),
  cachedEntityTags: async (ids: string[]) =>
    new Map(ids.map((id) => [id, ["Shared Tag", "Energetic", "Latin"]] as [string, string[]])),
  cachedInsights: async (args: { filterType?: string }, parts: { hop: number; exclude?: string[] }) => {
    const type = args.filterType ?? "urn:entity:artist";
    const excluded = new Set(parts.exclude ?? []);
    // `loadWatchHits` keeps the TV list only when it has at least 3 named shows; one
    // hit would fall through to movies (which this mock does not serve) and empty watch.
    const count = type === "urn:entity:tv_show" ? 3 : 1;
    const tagFor =
      type === "urn:entity:brand"
        ? [{ name: "Shared Tag" }, { name: "Apparel" }]
        : type === "urn:entity:place"
          ? [{ name: "Shared Tag" }, { name: "Live Music" }]
          : [{ name: "Shared Tag" }, { name: "Drama" }];
    const results = Array.from({ length: count }, (_, index) => ({
      entityId: `MOCK:${type}:${parts.hop}:${index}`,
      name: `${(type.split(":")[2] ?? "hit")}-${parts.hop}-${index}`,
      type,
      imageUrl: null,
      properties: {},
      raw: {
        entity_id: `MOCK:${type}:${parts.hop}:${index}`,
        tags: tagFor,
      },
    })).filter((hit) => !excluded.has(hit.entityId));
    return { provenance: "qloo", results, raw: {} };
  },
}));

/**
 * A reply for whichever prompt was sent: the anchor ids the prompt published, or a
 * narrative built only from the tokens the prompt allows (which passes the validator in
 * either language). With `valid: false` the narrative names nothing — no token — which
 * is exactly the failure a round has to be able to retry.
 */
function objectFor(prompt: string, valid: boolean): Record<string, unknown> {
  if (prompt.includes("anchorIds")) {
    const list = prompt.match(/Closed list: (\[[\s\S]*\])\s*$/);
    const rows = list ? (JSON.parse(list[1]!) as { id: string; slot: string }[]) : [];
    const slots = new Set<string>();
    const ids: string[] = [];
    for (const row of rows) {
      if (slots.has(row.slot)) continue;
      slots.add(row.slot);
      ids.push(row.id);
      if (ids.length === 2) break;
    }
    return { anchorIds: ids, reason: "shared tags" };
  }
  if (!valid) {
    return {
      rootsNarrative: "A night out",
      rootsHeadline: "Dos planes",
      bridgeNarrative: "A night out",
      bridgeHeadline: "Dos planes",
    };
  }
  const tokens: Record<string, string[]> = {};
  for (const block of prompt.matchAll(/"([AB])":\[(.*?)\]/g)) {
    tokens[block[1]!] = (block[2]!.match(/"([^"]+)"/g) ?? []).map((quoted) => quoted.slice(1, -1));
  }
  const text = (label: string) =>
    (tokens[label] ?? []).slice(0, 2).map((token) => `[[${token}]]`).join(" ");
  return {
    rootsNarrative: text("A"),
    rootsHeadline: "Dos planes",
    bridgeNarrative: text("B"),
    bridgeHeadline: "Dos planes",
  };
}

describe.runIf(SCRATCH !== null)("warm with an exhausted gemini chain", () => {
  let prisma: typeof import("../src/lib/db").prisma;
  let runWarmRounds: typeof import("./warm-run").runWarmRounds;
  let selectTargets: typeof import("./warm-run").selectTargets;
  let stopLine: typeof import("./warm-run").stopLine;
  let summaryLine: typeof import("./warm-run").summaryLine;
  let warmRowLine: typeof import("./warm-run").warmRowLine;
  let resetChain: () => void;

  beforeAll(async () => {
    process.env.DATABASE_URL = SCRATCH!;
    process.env.QLOO_API_KEY = process.env.QLOO_API_KEY?.trim() || "test-qloo-key";
    process.env.LLM_PROVIDER = "google";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-gemini-key";
    process.env.GEMINI_API_KEY = "";
    process.env.LLM_MODEL = "";
    process.env.GEMINI_MODEL = "live-model";
    process.env.GEMINI_FALLBACK_MODELS = "dead-a,dead-b";
    process.env.GEMINI_RETRY_ATTEMPTS = "1";

    const push = spawnSync("pnpm", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
      env: { ...process.env, DATABASE_URL: SCRATCH! },
      encoding: "utf8",
    });
    if (push.status !== 0) {
      throw new Error(`prisma db push failed: ${(push.stderr ?? "").split("\n").slice(-3).join(" ")}`);
    }

    ({ prisma } = await import("../src/lib/db"));
    ({ runWarmRounds, selectTargets, stopLine, summaryLine, warmRowLine } = await import("./warm-run"));
    ({ resetGoogleTransportForTests: resetChain } = await import("../src/lib/pipeline/llm"));
  }, 180_000);

  afterAll(async () => {
    if (!prisma) return;
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCRATCH_SCHEMA}" CASCADE`).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }, 60_000);

  const options = { untilOk: false, maxRounds: 1, pauseMs: 300_000 };

  /** The transcript an operator would see: the CLI's own line and summary formatters. */
  function transcript(result: Awaited<ReturnType<typeof runWarmRounds>>, targets: number, llmRows: number) {
    for (const row of result.rows) console.log(warmRowLine({ ...row, extra: `ms=${row.ms}` }));
    const stop = stopLine(result.stop, result.resetMs);
    if (stop) console.log(stop);
    console.log(
      summaryLine({
        rows: result.rows,
        rounds: result.rounds,
        geminiCalls: llm.calls,
        qlooCalls: 0,
        targets,
        llmRows,
      }),
    );
  }

  it("writes the template with the quota reason instead of failing the row", async () => {
    const { productionDeps } = await import("./warm-presets");
    resetChain();
    llm.calls = 0;
    llm.healthy = 2; // the first row narrates; every later call 429s per_day
    llm.valid = true;

    const targets = selectTargets(["roots-gt-la:en", "latin-tour-houston:en"]);
    const result = await runWarmRounds(targets, options, productionDeps);
    transcript(result, targets.length, 1);

    expect(result.rows.map((row) => `${row.presetId}:${row.status}:${row.reason}`)).toEqual([
      "roots-gt-la:cached:ok",
      "latin-tour-houston:template:quota_daily",
    ]);
    expect(result.rows.some((row) => row.status === "failed")).toBe(false);
    // The second row was not retried: every model was skipped, so another build could
    // only spend Qloo to reach the same template.
    expect(result.rows[1]!.attempts).toBe(1);

    // Both rows are stored, and every card of a stored pack carries a Qloo id.
    const stored = await prisma.packCache.findMany({ where: { isPreset: true } });
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      const payload = row.payload as { packs: { items: { qlooEntityId: string }[] }[] };
      expect(payload.packs).toHaveLength(2);
      for (const pack of payload.packs) {
        for (const item of pack.items) expect(item.qlooEntityId.trim()).not.toBe("");
      }
    }
  }, 180_000);

  it("stops the rounds on quota_daily and calls nothing on the next row", async () => {
    const { productionDeps } = await import("./warm-presets");
    resetChain();
    llm.calls = 0;
    llm.healthy = 0; // out of daily quota from the first call

    const first = await runWarmRounds(
      selectTargets(["fandom-con-nyc:en"]),
      { untilOk: true, maxRounds: 4, pauseMs: 60_000 },
      productionDeps,
    );
    transcript(first, 1, 0);
    // One row, template narration, and the round loop stops for the daily reset.
    expect(first.rows.map((row) => `${row.status}:${row.reason}`)).toEqual(["template:quota_daily"]);
    expect(first.stop).toBe("quota_daily");
    expect(first.resetMs).toBeGreaterThan(Date.now());
    // Discovering the two dead models cost one call each; nothing else did.
    const afterFirst = llm.calls;
    expect(afterFirst).toBeLessThanOrEqual(3);

    const second = await runWarmRounds(selectTargets(["fandom-con-nyc:es"]), options, productionDeps);
    transcript(second, 1, 0);
    expect(second.rows.map((row) => `${row.status}:${row.reason}`)).toEqual(["template:quota_daily"]);
    // The exhausted models are skipped without a call, so the next row spends nothing.
    expect(llm.calls).toBe(afterFirst);

    // Coverage names the skipped models, which is what explains the template row.
    const row = await prisma.packCache.findFirst({
      where: { isPreset: true },
      orderBy: { builtAt: "desc" },
    });
    const coverage = (row!.payload as { packs: { coverage: { llm?: { models?: unknown; off?: unknown } } }[] })
      .packs[0]!.coverage.llm;
    expect(JSON.stringify(coverage)).toContain("quota_daily");
    expect(JSON.stringify(coverage)).toContain("dead-a");
  }, 180_000);

  it("succeeds on round 2 when the first round's narration does not validate", async () => {
    const { productionDeps } = await import("./warm-presets");
    const asked: number[] = [];
    resetChain();
    llm.calls = 0;
    llm.healthy = 100;
    llm.valid = false;

    const targets = selectTargets(["latin-tour-houston:es"]);
    const result = await runWarmRounds(
      targets,
      { untilOk: true, maxRounds: 2, pauseMs: 60_000 },
      {
        ...productionDeps,
        // The clock is a seam: the pause is recorded instead of slept, and the model
        // recovers between the rounds, which is what a rate limit actually does.
        sleep: async (ms: number) => {
          asked.push(ms);
          // Only the pause *between rounds* lets the model recover: the row's own 2 s
          // retry pauses leave it failing, which is what makes this a round-2 success.
          if (ms >= 60_000) llm.valid = true;
        },
      },
    );
    transcript(result, 1, 1);

    expect(result.rows.map((row) => `${row.status}:${row.reason}`)).toEqual([
      "template:llm_error",
      "cached:ok",
    ]);
    expect(result.stop).toBe("all_llm");
    expect(result.rounds).toBe(2);
    // The pause between rounds is the requested one, and never under a minute.
    expect(asked.filter((ms) => ms >= 60_000)).toEqual([60_000]);
  }, 180_000);

  it("leaves a stored llm row alone instead of rebuilding it", async () => {
    const { productionDeps } = await import("./warm-presets");
    const { packSignature } = await import("../src/lib/pack/cache");
    const { PINNED_PRESETS } = await import("../src/lib/pipeline/config");
    const preset = PINNED_PRESETS.find((row) => row.id === "roots-gt-la")!;
    const signature = packSignature({
      entityIds: preset.seeds.map((seed) => seed.entityId!),
      city: preset.city,
      eventKind: preset.eventKind,
      locale: "en",
      mode: "default",
    });
    const llmRow = {
      city: preset.city,
      eventKind: preset.eventKind,
      locale: "en",
      seeds: [],
      packs: [
        { label: "A", axis: "root", narrative: "a", coverage: { llm: { narrative: "llm" } }, items: [] },
        { label: "B", axis: "bridge", narrative: "b", coverage: { llm: { narrative: "llm" } }, items: [] },
      ],
    };
    await prisma.packCache.deleteMany({ where: { signature } });
    await prisma.packCache.create({
      data: { signature, payload: llmRow, builtAt: new Date(), qlooCalls: 0, isPreset: true },
    });
    resetChain();
    llm.calls = 0;
    llm.healthy = 100;

    const result = await runWarmRounds(selectTargets(["roots-gt-la:en"]), options, productionDeps);

    expect(result.stop).toBe("all_llm");
    expect(result.rows).toHaveLength(0);
    expect(llm.calls).toBe(0);
    const after = await prisma.packCache.findUnique({ where: { signature } });
    expect(after!.payload).toEqual(llmRow);
  }, 180_000);
});

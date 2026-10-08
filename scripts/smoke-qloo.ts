import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { analysisCompare, enableSmokeGuards, insights, qlooGet, search } from "../src/lib/qloo/client";
import { resolveQlooBaseUrl } from "../src/lib/qloo/config";
import { toInsightsSearchParams } from "../src/lib/qloo/params";
import { DEMO_PRESETS } from "../src/lib/presets";
import {
  INSIGHT_ENTITY_TYPES,
  QlooGuardError,
  QlooHttpError,
  type InsightEntityType,
  type QlooInsightHit,
} from "../src/lib/qloo/types";

if (existsSync(".env")) {
  loadEnvFile(".env");
}

const apiKey = process.env.QLOO_API_KEY?.trim() ?? "";
if (!apiKey) {
  console.log("skipped_no_key");
  process.exit(0);
}

const LOCATION_CITIES = ["Los Angeles", "Houston", "New York"] as const;
const INTERESTING_KEY = /affinity|score|explain|reason|shared|tag/i;
const latencies: number[] = [];
let invocations = 0;

type CallResult<T> =
  | { ok: true; value: T; ms: number }
  | { ok: false; status: number; ms: number; detail?: string };

function statusLabel(call: { status: number; detail?: string }): string {
  return call.detail ? `status ${call.status} ${call.detail}` : `status ${call.status}`;
}

function httpErrorDetail(error: QlooHttpError): string | undefined {
  if (!("detail" in error)) return undefined;
  const detail = (error as { detail?: unknown }).detail;
  return typeof detail === "string" && detail ? detail.split(apiKey).join("[redacted]") : undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectedGates(): Set<string> {
  const index = process.argv.indexOf("--gates");
  const raw = index >= 0 ? process.argv[index + 1] : undefined;
  if (!raw) return new Set(["G0", "G1", "G2", "G3", "G4", "G5", "P"]);
  return new Set(
    raw
      .split(",")
      .map((part) => part.trim().toUpperCase())
      .filter(Boolean),
  );
}

async function timed<T>(fn: () => Promise<T>): Promise<CallResult<T>> {
  if (invocations > 0) await sleep(300);
  invocations += 1;
  const started = performance.now();
  try {
    const value = await fn();
    const ms = elapsed(started);
    latencies.push(ms);
    return { ok: true, value, ms };
  } catch (error) {
    const ms = elapsed(started);
    if (error instanceof QlooHttpError && (error.status === 401 || error.status === 403)) {
      throw new QlooGuardError(`Stopped on HTTP ${error.status}`);
    }
    if (error instanceof QlooGuardError) throw error;
    const status = error instanceof QlooHttpError ? error.status : 0;
    if (status !== 0) latencies.push(ms);
    const detail = error instanceof QlooHttpError ? httpErrorDetail(error) : undefined;
    return { ok: false, status, ms, detail };
  }
}

function rateHeadersOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || !("rateHeaders" in value)) return {};
  const headers = (value as { rateHeaders?: unknown }).rateHeaders;
  if (!headers || typeof headers !== "object") return {};
  const out: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(headers)) {
    if (/x-api-key|authorization|cookie/i.test(name)) continue;
    if (typeof headerValue === "string") out[name] = headerValue.split(apiKey).join("[redacted]");
  }
  return out;
}

function elapsed(started: number) {
  return Math.round((performance.now() - started) * 10) / 10;
}

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    const cleaned = value.split(apiKey).join("[redacted]");
    return cleaned.length > 500 ? `${cleaned.slice(0, 500)}…` : cleaned;
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = /api[-_]?key|token|secret|authorization|password/i.test(key)
        ? "[redacted]"
        : redact(child);
    }
    return out;
  }
  return value;
}

function topLevelKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value);
}

function interestingPaths(value: unknown, prefix = "", depth = 0, into: string[] = []): string[] {
  if (!value || typeof value !== "object" || depth > 3) return into;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (INTERESTING_KEY.test(key)) into.push(path);
    if (child && typeof child === "object") interestingPaths(child, path, depth + 1, into);
  }
  return into;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
  }
  return sorted[mid];
}

function idsOf(hits: QlooInsightHit[]): string[] {
  return hits.map((hit) => hit.entityId);
}

function overlap(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((id) => rightSet.has(id));
}

type ResolvedSeed = {
  presetId: string;
  query: string;
  expectedType: string;
  entityId: string | null;
  top: { name: string; id: string; type: string }[];
  firstTypeMatches: boolean | null;
  status: number | null;
  detail?: string;
};

const STATE_PATH = "docs/gates/state.json";

type GateState = {
  host: string;
  resolved: ResolvedSeed[];
  rateHeaders: Record<string, string>;
  g0: Record<string, unknown>;
  g2: unknown[];
  g3: unknown[];
  g5: unknown;
  probes: Record<string, unknown>;
  latency: { count: number; min: number; median: number; max: number };
  adjustments: { parameter: string; before: string; after: string; reason: string }[];
  aborted: string | null;
  apiAccess: string;
  p4: string;
};

function emptyState(): GateState {
  return {
    host: process.env.QLOO_BASE_URL?.trim() || "https://hackathon.api.qloo.com",
    resolved: [],
    rateHeaders: {},
    g0: {},
    g2: [],
    g3: [],
    g5: {},
    probes: {},
    latency: { count: 0, min: 0, median: 0, max: 0 },
    adjustments: [],
    aborted: null,
    apiAccess: "",
    p4: "",
  };
}

async function loadState(): Promise<GateState> {
  if (!existsSync(STATE_PATH)) return emptyState();
  try {
    return { ...emptyState(), ...(JSON.parse(await readFile(STATE_PATH, "utf8")) as GateState) };
  } catch {
    return emptyState();
  }
}

async function main() {
  const want = selectedGates();
  const state = await loadState();
  let base: URL;
  try {
    base = resolveQlooBaseUrl();
  } catch {
    console.error("host_not_allowlisted");
    process.exit(1);
  }
  state.host = base.host;
  enableSmokeGuards(150);
  const lines: string[] = [
    "# Qloo gates",
    "",
    "Generated by `scripts/smoke-qloo.ts`. This file records responses. It does not judge them.",
    "",
    `Host: ${state.host}`,
  ];
  const samples: Record<string, unknown> = {};
  let aborted: string | null = null;
  const runStarted = latencies.length;

  const resolved: ResolvedSeed[] = want.has("G1") ? [] : [...state.resolved];

  try {
    if (want.has("G1")) {
    for (const preset of DEMO_PRESETS) {
      for (const seed of preset.seeds) {
        const call = await timed(() => search({ query: seed.rawText, type: seed.type }));
        if (!call.ok) {
          resolved.push({
            presetId: preset.id,
            query: seed.rawText,
            expectedType: seed.type,
            entityId: null,
            top: [],
            firstTypeMatches: null,
            status: call.status,
            detail: call.detail,
          });
          continue;
        }
        const headers = rateHeadersOf(call.value);
        if (Object.keys(state.rateHeaders).length === 0 && Object.keys(headers).length > 0) {
          state.rateHeaders = headers;
        }
        const top = call.value.results.slice(0, 3).map((entity) => ({
          name: entity.name,
          id: entity.entityId,
          type: entity.type,
        }));
        const first = top[0];
        resolved.push({
          presetId: preset.id,
          query: seed.rawText,
          expectedType: seed.type,
          entityId: first?.id ?? null,
          top,
          firstTypeMatches: first ? first.type === seed.type : null,
          status: 200,
        });
      }
    }
    }
    state.resolved = resolved;
    samples.g1 = redact(resolved);

    const roots = resolved.filter((seed) => seed.presetId === "roots-gt-la" && seed.entityId);
    const latin = resolved.filter(
      (seed) => seed.presetId === "latin-tour-houston" && seed.entityId,
    );
    const groupA = roots.map((seed) => seed.entityId).filter((id): id is string => Boolean(id));
    const groupB = latin.map((seed) => seed.entityId).filter((id): id is string => Boolean(id));

    lines.push("", "## G0", "");
    if (!want.has("G0")) {
      lines.push("Not rerun.");
      const storedKeys = Array.isArray(state.g0.keys) ? state.g0.keys.join(", ") : "(none)";
      lines.push(`Stored status ${String(state.g0.status ?? "n/a")}; keys ${storedKeys}`);
    } else if (groupA.length === 0 || groupB.length === 0) {
      lines.push("analysisCompare skipped: fewer than two resolved groups.");
      lines.push(`Group A ids: ${groupA.join(", ") || "(none)"}`);
      lines.push(`Group B ids: ${groupB.join(", ") || "(none)"}`);
      state.g0 = { status: 0, keys: [], skipped: true, groupA, groupB };
    } else {
      const call = await timed(() => analysisCompare({ a: groupA, b: groupB }));
      if (!call.ok) {
        lines.push(`analysisCompare status: ${call.status}`);
        state.g0 = { status: call.status, keys: [], groupA, groupB };
      } else {
        lines.push("analysisCompare status: 200");
        lines.push(`Top-level keys: ${topLevelKeys(call.value.results).join(", ") || "(none)"}`);
        lines.push(`Group A: ${groupA.join(", ")}`);
        lines.push(`Group B: ${groupB.join(", ")}`);
        const g0 = {
          groupA,
          groupB,
          status: 200,
          keys: topLevelKeys(call.value.results),
          body: call.value.raw ?? call.value.results,
        };
        state.g0 = { status: 200, keys: g0.keys, groupA, groupB };
        samples.g0 = redact(g0);
      }
    }

    lines.push("", "## G1", "");
    for (const seed of resolved) {
      lines.push(
        `- ${seed.query} (${seed.expectedType}) ${seed.detail ? statusLabel({ status: seed.status ?? 0, detail: seed.detail }) : `status ${seed.status ?? "n/a"}`}; first type matches: ${String(seed.firstTypeMatches)}`,
      );
      for (const hit of seed.top) {
        lines.push(`  - ${hit.name} | ${hit.id} | ${hit.type}`);
      }
    }

    lines.push("", "## G2", "");
    const g2: unknown[] = want.has("G2") ? [] : [...state.g2];
    if (!want.has("G2")) {
      lines.push("Not rerun.");
      for (const row of g2 as InsightRow[]) {
        const affinity = (row.interestingKeys ?? [])
          .filter((key) => /affinity|score|explain|reason/i.test(key) && !/tags/i.test(key))
          .join(", ");
        lines.push(
          `- ${row.preset ?? "?"} ${row.filterType ?? "?"}: count ${row.count ?? "n/a"}; imageUrl ${row.imageCount ?? 0}/${row.count ?? 0}; sample host ${row.sampleImageHost ?? "none"}; properties ${(row.propertyNames ?? []).join(", ") || "(none)"}; affinity/score/explain ${affinity || "(none)"}; status ${row.status ?? "n/a"}`,
        );
      }
    } else {
    for (const preset of DEMO_PRESETS) {
      const ids = resolved
        .filter((seed) => seed.presetId === preset.id && seed.entityId)
        .map((seed) => seed.entityId as string);
      lines.push("", `### ${preset.id}`, "");
      if (ids.length === 0) {
        lines.push("Skipped: no resolved seed ids.");
        continue;
      }
      for (const filterType of INSIGHT_ENTITY_TYPES) {
        const row = await recordInsights(lines, filterType, {
          filterType,
          signalInterestsEntities: ids,
          take: 10,
        });
        g2.push({ preset: preset.id, ...row });
      }
    }
    }
    state.g2 = g2;
    samples.g2 = redact(g2);

    lines.push("", "## G3", "");
    const latinIds = groupB;
    const g3: unknown[] = want.has("G3") ? [] : [...state.g3];
    if (!want.has("G3")) {
      lines.push("Not rerun.");
      for (const row of g3 as LocationRow[]) {
        lines.push(
          `- ${row.city ?? "?"} ${row.filterType ?? "?"}: identical ${String(row.identical)}; without ${row.withoutStatus ?? "n/a"}; with ${row.withStatus ?? "n/a"}`,
        );
      }
    } else if (latinIds.length === 0) {
      lines.push("Skipped: Latin tour seeds did not resolve.");
    } else {
      for (const city of LOCATION_CITIES) {
        lines.push("", `### ${city}`, "");
        for (const filterType of INSIGHT_ENTITY_TYPES) {
          const baseArgs = {
            filterType,
            signalInterestsEntities: latinIds,
            take: 10,
          };
          const without = await timed(() => insights(baseArgs));
          const withLocation = await timed(() =>
            insights({ ...baseArgs, signalLocationQuery: city }),
          );
          const withoutIds = without.ok ? idsOf(without.value.results) : [];
          const withIds = withLocation.ok ? idsOf(withLocation.value.results) : [];
          const identical =
            without.ok && withLocation.ok && withoutIds.join("|") === withIds.join("|");
          lines.push(
            `- ${filterType}: without ${without.ok ? withoutIds.length : statusLabel(without)}, with location ${withLocation.ok ? withIds.length : statusLabel(withLocation)}, overlap ${overlap(withoutIds, withIds).length}, identical ${String(identical)}`,
          );
          g3.push({
            city,
            filterType,
            withoutIds,
            withIds,
            identical,
            withoutStatus: without.ok ? 200 : without.status,
            withStatus: withLocation.ok ? 200 : withLocation.status,
          });
        }
      }
    }
    state.g3 = g3;
    samples.g3 = redact(g3);

    lines.push("", "## G5", "");
    if (!want.has("G5")) {
      lines.push("Not rerun.");
      const stored = (state.g5 as { variants?: BridgeRow[] }).variants ?? [];
      for (const row of stored) {
        lines.push(
          `- variant ${row.variant} ${row.filterType}: count ${row.count ?? 0}; overlap ${(row.overlap ?? []).length}; status ${row.status ?? "n/a"}`,
        );
      }
    } else {
      const g5 = await runBridge(lines, latinIds);
      state.g5 = g5 as Record<string, unknown>;
      samples.g5 = redact(g5);
    }

    if (want.has("P")) {
      enableSmokeGuards(30);
      state.probes = await runProbes(lines, latinIds, g2, g3);
      state.apiAccess = await readApiAccess();
      state.p4 = await readParameterDocs();
      lines.push("", "## P1", "", state.apiAccess);
      lines.push(`Rate-limit headers: ${JSON.stringify(state.rateHeaders)}`);
      lines.push("", "## P4", "", state.p4);
    } else {
      lines.push("", "## Probes", "Not rerun.", state.apiAccess, state.p4);
    }
  } catch (error) {
    aborted = error instanceof Error ? error.message.split(apiKey).join("[redacted]") : "aborted";
    lines.push("", "## Abort", "", aborted);
  }

  const measured = latencies.slice(runStarted);
  const min = measured.length ? Math.min(...measured) : state.latency.min;
  const max = measured.length ? Math.max(...measured) : state.latency.max;
  const med = measured.length ? median(measured) : state.latency.median;
  if (measured.length > 0 && want.has("G4")) {
    state.latency = { count: measured.length, min, median: med, max };
  }
  lines.push("", "## G4", "");
  if (!want.has("G4")) lines.push("Not rerun. Stored measurement follows.");
  lines.push(`Measured client calls: ${state.latency.count}`);
  lines.push(
    `Latency ms: min ${state.latency.min}, median ${state.latency.median}, max ${state.latency.max}`,
  );
  lines.push(
    "Calls a hop-0 + hop-1 pack would make: 3 seed searches + 1 tags call + 5 hop-0 insight calls (tv_show, movie, artist, brand, place) + 5 hop-1 insight calls = 14.",
  );
  lines.push(
    `Estimated pack time at the measured median: ${Math.round((state.latency.median * 14) / 10) / 100} s.`,
  );

  state.aborted = aborted;
  await mkdir("docs/gates", { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(redact(state), null, 2)}\n`);
  await writeFile("docs/gates.md", `${lines.join("\n")}\n`);
  await writeFile("docs/gates-share.md", renderShare(state));
  await Promise.all(
    Object.entries(samples).map(([name, value]) =>
      writeFile(`docs/gates/${name}.json`, `${JSON.stringify(value, null, 2)}\n`),
    ),
  );
  if (state.probes && Object.keys(state.probes).length > 0) {
    await writeFile("docs/gates/probes.json", `${JSON.stringify(redact(state.probes), null, 2)}\n`);
  }

  if (aborted) process.exitCode = 1;
}

async function recordInsights(
  lines: string[],
  filterType: InsightEntityType,
  args: Parameters<typeof insights>[0],
) {
  const call = await timed(() => insights(args));
  if (!call.ok) {
    lines.push(`- ${filterType}: ${statusLabel(call)}`);
    return { filterType, status: call.status };
  }
  const hits = call.value.results;
  const first = hits[0];
  const names = first ? Object.keys(first.properties) : [];
  const interesting = first
    ? [...new Set([...interestingPaths(first.raw), ...interestingPaths(call.value.raw)])]
    : interestingPaths(call.value.raw);
  const imageCount = hits.filter((hit) => Boolean(hit.imageUrl)).length;
  const sampleImageHost = imageHost(hits.find((hit) => hit.imageUrl)?.imageUrl ?? null);
  lines.push(
    `- ${filterType}: count ${hits.length}; imageUrl ${imageCount}/${hits.length}; sample host ${sampleImageHost ?? "none"}; properties ${names.join(", ") || "(none)"}; affinity/score/explain keys ${interesting.join(", ") || "(none)"}`,
  );
  return {
    filterType,
    count: hits.length,
    imageUrl: Boolean(first?.imageUrl),
    imageCount,
    sampleImageHost,
    propertyNames: names,
    interestingKeys: interesting,
    status: 200,
    first: truncateRaw(first?.raw ?? null),
    responseKeys: topLevelKeys(call.value.raw),
  };
}

function imageHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function truncateRaw(value: unknown): unknown {
  const text = JSON.stringify(redact(value));
  if (!text) return null;
  if (text.length <= 2048) return redact(value);
  return { truncated: true, json: `${text.slice(0, 2048)}…` };
}

async function runBridge(lines: string[], latinIds: string[]) {
  if (latinIds.length === 0) {
    lines.push("Skipped: Latin tour seeds did not resolve.");
    return { skipped: true };
  }

  const hop0 = new Map<InsightEntityType, QlooInsightHit[]>();
  for (const filterType of INSIGHT_ENTITY_TYPES) {
    const call = await timed(() =>
      insights({
        filterType,
        signalInterestsEntities: latinIds,
        take: 10,
      }),
    );
    hop0.set(filterType, call.ok ? call.value.results : []);
    lines.push(
      `- hop 0 ${filterType}: ${call.ok ? call.value.results.length : statusLabel(call)}`,
    );
  }

  const rootIds = [...hop0.values()].flatMap((hits) => idsOf(hits));
  const anchors: { type: InsightEntityType; entityId: string }[] = [];
  for (const filterType of INSIGHT_ENTITY_TYPES) {
    const first = hop0.get(filterType)?.[0];
    if (!first) continue;
    anchors.push({ type: filterType, entityId: first.entityId });
    if (anchors.length === 2) break;
  }

  if (anchors.length < 2) {
    lines.push("Hop 1 skipped: fewer than two hop-0 picks from different types.");
    return { rootIds, anchors };
  }

  const anchorIds = anchors.map((anchor) => anchor.entityId);
  lines.push(`Anchors: ${anchors.map((anchor) => `${anchor.type} ${anchor.entityId}`).join("; ")}`);

  const bias = process.env.SMOKE_BIAS_TRENDS?.trim() ?? "";
  const popularityRaw = process.env.SMOKE_POPULARITY_MAX?.trim() ?? "";
  const popularity = popularityRaw === "" ? null : Number(popularityRaw);
  const variants: {
    id: string;
    biasTrends?: string;
    filterPopularityMax?: number;
  }[] = [{ id: "a" }];
  if (bias) variants.push({ id: "b", biasTrends: bias });
  else lines.push("Variant b skipped: SMOKE_BIAS_TRENDS is unset.");
  if (popularity !== null && Number.isFinite(popularity)) {
    variants.push({ id: "c", filterPopularityMax: popularity });
  } else {
    lines.push("Variant c skipped: SMOKE_POPULARITY_MAX is unset or not a number.");
  }

  const recorded = [];
  for (const variant of variants) {
    for (const filterType of INSIGHT_ENTITY_TYPES) {
      const call = await timed(() =>
        insights({
          filterType,
          signalInterestsEntities: anchorIds,
          signalLocationQuery: "Houston",
          filterExcludeEntities: rootIds,
          take: 10,
          biasTrends: variant.biasTrends,
          filterPopularityMax: variant.filterPopularityMax,
        }),
      );
      const variantIds = call.ok ? idsOf(call.value.results) : [];
      const shared = overlap(variantIds, rootIds);
      lines.push(
        `- variant ${variant.id} ${filterType}: ${call.ok ? variantIds.length : statusLabel(call)}; overlap with Roots ${shared.length}`,
      );
      recorded.push({
        variant: variant.id,
        filterType,
        count: variantIds.length,
        overlap: shared,
        status: call.ok ? 200 : call.status,
      });
    }
  }

  return { rootIds, anchors, variants: recorded, bias: bias || null, popularity: popularityRaw || null };
}

type InsightRow = {
  preset?: string;
  filterType?: string;
  count?: number;
  imageCount?: number;
  sampleImageHost?: string | null;
  propertyNames?: string[];
  interestingKeys?: string[];
  status?: number;
  responseKeys?: string[];
  first?: unknown;
};

type LocationRow = {
  city?: string;
  filterType?: string;
  identical?: boolean;
  withoutIds?: string[];
  withIds?: string[];
  withoutStatus?: number;
  withStatus?: number;
};

type BridgeRow = {
  variant?: string;
  filterType?: string;
  count?: number;
  overlap?: string[];
  status?: number;
};

function idsFromBody(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const record = body as { results?: unknown };
  const results = record.results;
  const list = Array.isArray(results)
    ? results
    : results && typeof results === "object" && Array.isArray((results as { entities?: unknown }).entities)
      ? (results as { entities: unknown[] }).entities
      : [];
  return list.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const id = (entry as { entity_id?: unknown; id?: unknown }).entity_id ?? (entry as { id?: unknown }).id;
    return typeof id === "string" ? [id] : [];
  });
}

async function readParameterDocs(): Promise<string> {
  const parametersUrl = "https://raw.githubusercontent.com/qloo/docs-public/main/reference/parameters.md";
  const deepUrl = "https://raw.githubusercontent.com/qloo/docs-public/main/reference/insights-api-deep-dive.md";
  try {
    const response = await fetch(parametersUrl);
    if (!response.ok) return `parameters.md HTTP ${response.status}`;
    const text = await response.text();
    const popularity = /between 0 and 1/.test(text) ? "scale 0-1" : "scale not found in parameters.md";
    const example = text.includes("0.98") ? "example 0.98" : "no 0.98 example";
    const biasInParameters = /bias\.trends/.test(text);
    let bias = biasInParameters
      ? "bias.trends mentioned in parameters.md"
      : "bias.trends absent from parameters.md";
    const deep = await fetch(deepUrl);
    if (!deep.ok) {
      bias = `${bias}; insights deep dive HTTP ${deep.status}`;
    } else {
      const deepText = await deep.text();
      const hasEnum =
        /bias\.trends/.test(deepText) &&
        /`off`/.test(deepText) &&
        /`low`/.test(deepText) &&
        /`medium`/.test(deepText) &&
        /`high`/.test(deepText);
      bias = hasEnum
        ? `${bias}; deep dive allowed values off, low, medium, high`
        : `${bias}; deep dive fetched (${deepText.length} bytes), enum not found`;
    }
    return `popularity ${popularity} (${example}). ${bias}.`;
  } catch {
    return "Could not read parameter docs.";
  }
}

async function readApiAccess(): Promise<string> {
  try {
    const response = await fetch(
      "https://raw.githubusercontent.com/qloo/qloo-hackathon-kit/main/docs/API_ACCESS.md",
    );
    if (!response.ok) return `Could not read API_ACCESS.md (HTTP ${response.status}).`;
    const text = await response.text();
    const numeric = /\b\d+\s*(requests?|calls?|qps|rpm|rps|per minute|per second)\b/i.test(text);
    return [
      `bytes=${text.length}`,
      `numeric_limit=${numeric}`,
      `mentions_publish_quota=${/publish the event quota/i.test(text)}`,
      `mentions_harness=${/qloo explore/i.test(text)}`,
    ].join("; ");
  } catch {
    return "Could not read API_ACCESS.md.";
  }
}

async function runProbes(
  lines: string[],
  latinIds: string[],
  g2: unknown[],
  g3: unknown[],
): Promise<Record<string, unknown>> {
  const probes: Record<string, unknown> = {};
  lines.push("", "## Probes", "");
  let rows = (g2 as InsightRow[]).filter((row) => row.preset === "latin-tour-houston");
  if (rows.length === 0 && latinIds.length > 0) {
    for (const filterType of INSIGHT_ENTITY_TYPES) {
      const row = await recordInsights(lines, filterType, {
        filterType,
        signalInterestsEntities: latinIds,
        take: 10,
      });
      rows.push({ preset: "latin-tour-houston", ...row });
    }
  }
  probes.p2 = rows.map((row) => ({
    filterType: row.filterType,
    status: row.status,
    count: row.count,
    responseKeys: row.responseKeys ?? [],
    interestingKeys: row.interestingKeys ?? [],
    propertyNames: row.propertyNames ?? [],
    first: row.first ?? null,
  }));
  lines.push(`P2 types recorded: ${rows.length}`);

  if (latinIds.length > 0) {
    const params = toInsightsSearchParams({
      filterType: "urn:entity:movie",
      signalInterestsEntities: latinIds,
      take: 5,
    });
    params.set("feature.explainability", "true");
    const call = await timed(() => qlooGet("/v2/insights", params));
    const body = call.ok ? call.value.body : null;
    const status = call.ok ? call.value.status : call.status;
    probes.p3 = {
      status,
      accepted: status === 200,
      keys: topLevelKeys(body),
      hints: interestingPaths(body),
    };
    lines.push(`P3 feature.explainability status ${status}`);
  } else {
    probes.p3 = { skipped: true };
    lines.push("P3 skipped: no resolved Latin tour ids.");
  }

  const placeRows = (g3 as LocationRow[]).filter((row) => row.filterType === "urn:entity:place");
  const locationIgnored =
    placeRows.length > 0 && placeRows.every((row) => row.identical === true);
  if (locationIgnored && latinIds.length > 0) {
    const baseline =
      placeRows.find((row) => row.city === "Houston")?.withoutIds ??
      placeRows[0]?.withoutIds ??
      [];
    const params = toInsightsSearchParams({
      filterType: "urn:entity:place",
      signalInterestsEntities: latinIds,
      take: 10,
    });
    params.set("filter.geocode.name", "Houston");
    const call = await timed(() => qlooGet("/v2/insights", params));
    const ids = call.ok && call.value.status === 200 ? idsFromBody(call.value.body) : [];
    const shared = overlap(ids, baseline);
    probes.p5 = {
      status: call.ok ? call.value.status : call.status,
      baselineCount: baseline.length,
      geocodeCount: ids.length,
      overlap: shared.length,
      identical: ids.join("|") === baseline.join("|"),
    };
    lines.push(
      `P5 filter.geocode.name=Houston status ${call.ok ? call.value.status : call.status}; overlap ${shared.length}`,
    );
  } else {
    probes.p5 = {
      skipped: true,
      reason: "signal.location.query was not ignored for every place comparison",
    };
    lines.push("P5 skipped: place location was not ignored on every city.");
  }

  const images: Record<string, { hits: number; withImage: number; host: string | null }> = {};
  for (const row of g2 as InsightRow[]) {
    const type = row.filterType ?? "unknown";
    const bucket = images[type] ?? { hits: 0, withImage: 0, host: null };
    bucket.hits += row.count ?? 0;
    bucket.withImage += row.imageCount ?? 0;
    if (!bucket.host && row.sampleImageHost) bucket.host = row.sampleImageHost;
    images[type] = bucket;
  }
  probes.p6 = images;
  lines.push("P6 image counts recorded from G2.");
  return probes;
}

function renderShare(state: GateState): string {
  const lines: string[] = ["# DropQ gates (share)", "", `Host: ${state.host}`, ""];
  const g1Parts = DEMO_PRESETS.map((preset) => {
    const seeds = state.resolved.filter((seed) => seed.presetId === preset.id);
    const matched = seeds.filter((seed) => seed.firstTypeMatches).length;
    const misses = seeds
      .filter((seed) => !seed.firstTypeMatches)
      .map((seed) => `${seed.query}=${seed.top[0]?.name ?? "none"}/${seed.top[0]?.type ?? seed.status}`)
      .join(", ");
    return `${preset.id} ${matched}/3${misses ? ` (${misses})` : ""}`;
  });
  const g1Matched = DEMO_PRESETS.map((preset) =>
    state.resolved.filter((seed) => seed.presetId === preset.id && seed.firstTypeMatches).length,
  );
  const g1Result = g1Matched.every((count) => count === 3)
    ? "pass"
    : g1Matched.some((count) => count > 0)
      ? "partial"
      : "fail";

  const g2 = state.g2 as InsightRow[];
  const g2Ok = g2.filter((row) => (row.count ?? 0) >= 3).length;
  const g2Result = g2.length === 0 ? "fail" : g2Ok === g2.length ? "pass" : g2Ok === 0 ? "fail" : "partial";
  const g2Line = g2
    .map(
      (row) =>
        `${row.preset?.replace("-tour-houston", "") ?? "?"} ${String(row.filterType).replace("urn:entity:", "")} ${row.count ?? row.status} img ${row.imageCount ?? 0}`,
    )
    .join("; ");

  const g3 = state.g3 as LocationRow[];
  const comparable = g3.filter((row) => row.withoutStatus === 200 && row.withStatus === 200);
  const changed = comparable.filter((row) => row.identical === false).length;
  const failed = g3.filter((row) => row.withoutStatus !== 200 || row.withStatus !== 200);
  const g3Result =
    g3.length === 0
      ? "fail"
      : failed.length === 0 && changed === g3.length
        ? "pass"
        : changed === 0 && comparable.length === 0
          ? "fail"
          : "partial";
  const ignored = [
    ...new Set(
      comparable
        .filter((row) => row.identical)
        .map((row) => `${row.city} ${String(row.filterType).replace("urn:entity:", "")}`),
    ),
  ];
  const failedNote = failed
    .map(
      (row) =>
        `${row.city} ${String(row.filterType).replace("urn:entity:", "")} ${row.withoutStatus}/${row.withStatus}`,
    )
    .join(", ");

  const estSeconds = Math.round((state.latency.median * 14) / 10) / 100;
  const g4Result = state.latency.count === 0 ? "fail" : estSeconds < 12 ? "pass" : "partial";

  const variants = (state.g5 as { variants?: BridgeRow[] }).variants ?? [];
  const ratios = variants
    .filter((row) => (row.count ?? 0) > 0)
    .map((row) => (row.overlap?.length ?? 0) / (row.count as number));
  const failedVariants = variants.filter((row) => row.status !== 200);
  const g5Result =
    variants.length === 0
      ? "fail"
      : ratios.length === 0
        ? "fail"
        : ratios.every((ratio) => ratio < 0.5) && failedVariants.length === 0
          ? "pass"
          : ratios.some((ratio) => ratio < 0.5)
            ? "partial"
            : "fail";
  const g5Line = variants
    .map((row) => {
      const count = row.count ?? 0;
      const ratio = count === 0 ? "n/a" : `${Math.round(((row.overlap?.length ?? 0) / count) * 100)}%`;
      return `${row.variant}/${String(row.filterType).replace("urn:entity:", "")} ${ratio} (${row.overlap?.length ?? 0}/${count})`;
    })
    .join("; ");

  const g0Status = state.g0.status ?? "n/a";
  const g0Keys = Array.isArray(state.g0.keys) ? state.g0.keys.join(", ") : "";
  const g0Result = g0Status === 200 ? "pass" : state.g0.skipped ? "partial" : "fail";
  const headerLine =
    Object.keys(state.rateHeaders).length === 0
      ? "none"
      : Object.entries(state.rateHeaders)
          .map(([name, value]) => `${name}=${value}`)
          .join(", ");

  lines.push("| Gate | Result | Evidence |");
  lines.push("| --- | --- | --- |");
  lines.push(`| G0 | ${g0Result} | status ${g0Status}; keys ${g0Keys || "(none)"}; rate headers ${headerLine} |`);
  lines.push(`| G1 | ${g1Result} | ${g1Parts.join("; ")} |`);
  lines.push(`| G2 | ${g2Result} | ${g2Ok}/${g2.length} pairs with count >= 3. ${g2Line} |`);
  lines.push(`| G3 | ${g3Result} | ${changed}/${g3.length} comparisons changed. Identical: ${ignored.join(", ") || "(none)"}. Unresolved: ${failedNote || "(none)"} |`);
  lines.push(`| G4 | ${g4Result} | min ${state.latency.min} ms, median ${state.latency.median} ms, max ${state.latency.max} ms; pack calls 14; estimated ${estSeconds} s |`);
  lines.push(`| G5 | ${g5Result} | ${g5Line || "no variants"} |`);
  lines.push("");
  lines.push("## Findings that change the design");
  const affinity = [
    ...new Set(
      g2.flatMap((row) =>
        (row.interestingKeys ?? []).filter(
          (key) => /affinity|score|explain|reason/i.test(key) && !/tags/i.test(key),
        ),
      ),
    ),
  ];
  const nameGaps = state.resolved
    .filter((seed) => seed.top[0] && seed.top[0].name.toLowerCase() !== seed.query.toLowerCase())
    .map((seed) => `${seed.query} -> ${seed.top[0]?.name}`);
  const explain = state.probes.p3 ?? { skipped: true };
  lines.push(`- Affinity or score fields: ${affinity.join(", ") || "none found"}. Entity tag lists are present.`);
  lines.push(`- Explainability probe: ${JSON.stringify(explain)}.`);
  lines.push(`- Location signal changed every completed list. Unresolved: ${failedNote || "(none)"}.`);
  lines.push(`- First-hit name differs from the seed text: ${nameGaps.join("; ") || "none"}.`);
  lines.push(
    `- Images: ${Object.entries((state.probes.p6 as Record<string, { hits: number; withImage: number; host: string | null }>) ?? {}).map(([type, bucket]) => `${type.replace("urn:entity:", "")} ${bucket.withImage}/${bucket.hits} host ${bucket.host ?? "none"}`).join("; ") || "not recorded"}. Place rows also list a properties.images field.`,
  );
  lines.push("");
  lines.push("## Adjustments");
  if (state.adjustments.length === 0) lines.push("- none");
  for (const change of state.adjustments) {
    lines.push(`- ${change.parameter}: ${change.before} -> ${change.after}. ${change.reason}`);
  }
  lines.push("");
  lines.push("## Probes");
  lines.push(`- P1 rate headers: ${headerLine}. API_ACCESS.md: ${state.apiAccess || "not read"}.`);
  const savedBias = (state.g5 as { bias?: string | null }).bias || "";
  const savedPopularity = (state.g5 as { popularity?: string | null }).popularity || "";
  lines.push(
    `- P4 ${state.p4 || "parameter docs not read"} Saved G5 inputs: SMOKE_BIAS_TRENDS=${savedBias || "(unset)"} and SMOKE_POPULARITY_MAX=${savedPopularity || "(unset)"}.`,
  );
  const placeFailed = failed.filter((row) => String(row.filterType).includes("place"));
  lines.push(
    placeFailed.length > 0
      ? `- P5 skipped: ${placeFailed.length} place location calls did not return HTTP 200, so an identical unfiltered list was not shown.`
      : `- P5: ${JSON.stringify(state.probes.p5 ?? { skipped: true })}.`,
  );
  lines.push("");
  lines.push("## Not done");
  const undone: string[] = [];
  if (state.aborted) undone.push(`Run aborted: ${state.aborted}`);
  if (!variants.some((row) => row.variant === "b")) {
    undone.push("G5 variant b was not run because SMOKE_BIAS_TRENDS was unset.");
  }
  if (!variants.some((row) => row.variant === "c")) {
    undone.push("G5 variant c was not run because SMOKE_POPULARITY_MAX was unset.");
  }
  if (failed.length > 0) undone.push(`Location calls without two HTTP 200 lists: ${failedNote}.`);
  if (failedVariants.length > 0) {
    undone.push(
      `Bridge calls that were not HTTP 200: ${failedVariants.map((row) => `${row.variant}/${String(row.filterType).replace("urn:entity:", "")} ${row.status}`).join(", ")}.`,
    );
  }
  if (undone.length === 0) undone.push("none");
  for (const item of undone) lines.push(`- ${item}`);
  lines.push("");
  const text = `${lines.join("\n")}\n`;
  if (text.split("\n").length > 150) {
    return `${lines.slice(0, 140).join("\n")}\n\nTruncated to stay within 150 lines.\n`;
  }
  return text;
}

void main();

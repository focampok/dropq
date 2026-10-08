import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { enableSmokeGuards, qlooGet, search } from "../src/lib/qloo/client";
import { resolveQlooBaseUrl } from "../src/lib/qloo/config";
import { toInsightsSearchParams } from "../src/lib/qloo/params";
import { QlooGuardError, QlooHttpError, type InsightEntityType } from "../src/lib/qloo/types";

if (existsSync(".env")) loadEnvFile(".env");

const apiKey = process.env.QLOO_API_KEY?.trim() ?? "";
if (!apiKey) {
  console.log("skipped_no_key");
  process.exit(0);
}

const CALL_CAP = 60;
const PLACE_PROBE_TIMEOUT_MS = 25_000;
const RADIUS_METERS = 20_000;
const TYPES: InsightEntityType[] = [
  "urn:entity:tv_show",
  "urn:entity:movie",
  "urn:entity:artist",
  "urn:entity:brand",
  "urn:entity:place",
];
const LATIN_IDS = [
  "BDA1B73F-10E7-4D09-AC51-B796CCEC5FF3",
  "658495BB-DF77-472E-A6B2-9E37FF248FB3",
  "C70CE2B8-0AD1-4150-BF18-5A6347F2E860",
];
const CITIES = [
  { name: "Los Angeles", lat: 34.0522, lon: -118.2437 },
  { name: "Houston", lat: 29.7604, lon: -95.3698 },
  { name: "New York", lat: 40.7128, lon: -74.006 },
] as const;
const BEER = /beer|cerveza|lager|brew|pilsner|cervec/i;
const ALCOHOL = /alcohol|wine|spirit|liquor/i;

type Hit = { id: string; name: string; tags: string[] };
type CallOk = {
  ok: true;
  status: number;
  ms: number;
  hits: Hit[];
  query: unknown;
  raw: unknown;
};
type CallFail = { ok: false; status: number; ms: number; detail?: string };
type CallResult = CallOk | CallFail;

let calls = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redact(value: unknown): unknown {
  if (typeof value === "string") return value.split(apiKey).join("[redacted]");
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

function truncate(value: unknown, max: number): unknown {
  const text = JSON.stringify(redact(value));
  if (!text) return null;
  if (text.length <= max) return redact(value);
  return { truncated: true, chars: text.length, json: `${text.slice(0, max)}…` };
}

function tagNames(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const tags = (value as { tags?: unknown }).tags;
  if (!Array.isArray(tags)) return [];
  return tags.flatMap((tag) => {
    if (!tag || typeof tag !== "object") return [];
    const name = (tag as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  });
}

function hitsFromBody(body: unknown): Hit[] {
  if (!body || typeof body !== "object") return [];
  const results = (body as { results?: unknown }).results;
  const list = Array.isArray(results)
    ? results
    : results && typeof results === "object" && Array.isArray((results as { entities?: unknown }).entities)
      ? (results as { entities: unknown[] }).entities
      : [];
  return list.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as { entity_id?: unknown; id?: unknown; name?: unknown };
    const id = typeof record.entity_id === "string" ? record.entity_id : record.id;
    if (typeof id !== "string" || !id) return [];
    return [{ id, name: typeof record.name === "string" ? record.name : "", tags: tagNames(entry) }];
  });
}

function queryOf(body: unknown): unknown {
  if (!body || typeof body !== "object") return null;
  return (body as { query?: unknown }).query ?? null;
}

function httpDetail(error: unknown): string | undefined {
  if (!(error instanceof QlooHttpError) || !("detail" in error)) return undefined;
  const detail = (error as { detail?: unknown }).detail;
  return typeof detail === "string" ? detail.split(apiKey).join("[redacted]") : undefined;
}

async function call(
  label: string,
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<CallResult> {
  if (calls >= CALL_CAP) {
    throw new QlooGuardError("Qloo call cap reached");
  }
  if (calls > 0) await sleep(300);
  calls += 1;
  const started = performance.now();
  try {
    const value = await run();
    const ms = Math.round(performance.now() - started);
    console.log(`${label} ${value.status} ${ms}ms`);
    if (value.status !== 200) {
      const detail =
        value.body && typeof value.body === "object" && "error" in value.body
          ? String((value.body as { error?: unknown }).error ?? "")
              .split(apiKey)
              .join("[redacted]")
          : undefined;
      return { ok: false, status: value.status, ms, detail };
    }
    return { ok: true, status: value.status, ms, hits: hitsFromBody(value.body), query: queryOf(value.body), raw: value.body };
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    if (error instanceof QlooHttpError && (error.status === 401 || error.status === 403)) {
      throw new QlooGuardError(`Stopped on HTTP ${error.status}`);
    }
    if (error instanceof QlooGuardError) throw error;
    const status = error instanceof QlooHttpError ? error.status : 0;
    console.log(`${label} ${status} ${ms}ms`);
    return { ok: false, status, ms, detail: httpDetail(error) };
  }
}

async function insightsCall(
  label: string,
  params: URLSearchParams,
  timeoutMs: number,
): Promise<CallResult> {
  return call(label, async () => {
    const response = await qlooGet("/v2/insights", params, timeoutMs);
    return { status: response.status, body: response.body };
  });
}

function topNames(result: CallResult, count = 5): string[] {
  if (!result.ok) return [];
  return result.hits.slice(0, count).map((hit) => hit.name || hit.id);
}

function idsOf(result: CallResult): string[] {
  return result.ok ? result.hits.map((hit) => hit.id) : [];
}

function sharedIds(left: string[], right: string[]): number {
  const set = new Set(right);
  return left.filter((id) => set.has(id)).length;
}

function tagOverlap(bridge: CallResult, roots: CallResult): { shared: number; bridge: number } {
  if (!bridge.ok || !roots.ok) return { shared: 0, bridge: 0 };
  const rootTags = new Set(roots.hits.flatMap((hit) => hit.tags.map((tag) => tag.toLowerCase())));
  const bridgeTags = new Set(bridge.hits.flatMap((hit) => hit.tags.map((tag) => tag.toLowerCase())));
  let shared = 0;
  for (const tag of bridgeTags) if (rootTags.has(tag)) shared += 1;
  return { shared, bridge: bridgeTags.size };
}

function shortType(type: string): string {
  return type.replace("urn:entity:", "");
}

async function readDocs(): Promise<string> {
  const parametersUrl = "https://raw.githubusercontent.com/qloo/docs-public/main/reference/parameters.md";
  const byTypeUrl =
    "https://raw.githubusercontent.com/qloo/docs-public/main/reference/available-parameters-by-entity-type.md";
  try {
    const [parameters, byType] = await Promise.all([fetch(parametersUrl), fetch(byTypeUrl)]);
    if (!parameters.ok || !byType.ok) {
      return `parameters HTTP ${parameters.status}; by-type HTTP ${byType.status}`;
    }
    const text = await parameters.text();
    const place = await byType.text();
    const placeSection = place.split("## Place")[1]?.split("## ")[0] ?? "";
    return [
      `parameters_bytes=${text.length}`,
      `geocode_name=${/filter\.geocode\.name/.test(text)}`,
      `country_code=${/filter\.geocode\.country_code/.test(text)}`,
      `location_point=${/longitude is first/.test(text)}`,
      `radius_meters=${/radius \(in meters\)/.test(text)}`,
      `place_lists_geocode_name=${/filter\.geocode\.name/.test(placeSection)}`,
      `place_lists_country_code=${/filter\.geocode\.country_code/.test(placeSection)}`,
      `place_lists_location=${/\| `filter\.location` \|/.test(placeSection)}`,
      `place_lists_radius=${/filter\.location\.radius/.test(placeSection)}`,
    ].join("; ");
  } catch {
    return "Could not read parameter docs.";
  }
}

function docsAllow(summary: string, flag: string): boolean {
  return summary.includes(`${flag}=true`);
}

async function main() {
  let baseHost = "hackathon.api.qloo.com";
  try {
    baseHost = resolveQlooBaseUrl().host;
  } catch {
    console.error("host_not_allowlisted");
    process.exit(1);
  }
  enableSmokeGuards(CALL_CAP);
  const lines: string[] = ["# Qloo round 2", "", `Host: ${baseHost}`, ""];
  let aborted: string | null = null;
  const docs = await readDocs();
  lines.push("## Docs", "", docs, "");
  const allowCountry = docsAllow(docs, "country_code") && docsAllow(docs, "place_lists_country_code");
  const allowRadius = docsAllow(docs, "radius_meters") && docsAllow(docs, "place_lists_radius");
  const allowPoint = docsAllow(docs, "location_point") && docsAllow(docs, "place_lists_location");
  const allowGeocode = docsAllow(docs, "geocode_name") && docsAllow(docs, "place_lists_geocode_name");

  const roots = new Map<string, CallResult>();
  const variants = new Map<string, { a: CallResult; b: CallResult; c: CallResult }>();
  const locations = new Map<string, CallResult>();
  const explained = new Map<string, CallResult>();
  const places: { strategy: string; city: string; anchors: boolean; result: CallResult }[] = [];
  const searches: { query: string; type: string; result: CallResult; propertyKeys: string[]; hasTags: boolean }[] =
    [];

  try {
    lines.push("## R1", "");
    for (const filterType of TYPES) {
      const params = toInsightsSearchParams({
        filterType,
        signalInterestsEntities: LATIN_IDS,
        take: 10,
      });
      const timeout = filterType === "urn:entity:place" ? PLACE_PROBE_TIMEOUT_MS : 8_000;
      roots.set(filterType, await insightsCall(`R1 ${shortType(filterType)} hop0`, params, timeout));
    }

    const anchorOrder: InsightEntityType[] = [
      "urn:entity:movie",
      "urn:entity:artist",
      "urn:entity:brand",
      "urn:entity:tv_show",
    ];
    const anchors: { type: string; id: string; name: string }[] = [];
    for (const filterType of anchorOrder) {
      const first = roots.get(filterType);
      const hit = first?.ok ? first.hits[0] : undefined;
      if (!hit) continue;
      anchors.push({ type: filterType, id: hit.id, name: hit.name });
      if (anchors.length === 3) break;
    }
    lines.push(`Anchors: ${anchors.map((anchor) => `${shortType(anchor.type)} ${anchor.name}`).join("; ") || "(none)"}`);
    const anchorIds = anchors.map((anchor) => anchor.id);

    if (anchorIds.length >= 2) {
      for (const filterType of TYPES) {
        const rootIds = idsOf(roots.get(filterType) ?? { ok: false, status: 0, ms: 0 });
        const timeout = filterType === "urn:entity:place" ? PLACE_PROBE_TIMEOUT_MS : 8_000;
        const base = toInsightsSearchParams({
          filterType,
          signalInterestsEntities: anchorIds,
          signalLocationQuery: "Houston",
          filterExcludeEntities: rootIds,
          take: 10,
        });
        const a = await insightsCall(`R1a ${shortType(filterType)}`, base, timeout);
        const bParams = new URLSearchParams(base);
        bParams.set("bias.trends", "high");
        const b = await insightsCall(`R1b ${shortType(filterType)}`, bParams, timeout);
        const cParams = new URLSearchParams(base);
        cParams.set("filter.popularity.max", "0.98");
        const c = await insightsCall(`R1c ${shortType(filterType)}`, cParams, timeout);
        variants.set(filterType, { a, b, c });
      }
    }

    if (anchorIds.length >= 2) {
      lines.push("", "## R2", "");
      for (const filterType of ["urn:entity:brand", "urn:entity:movie"] as const) {
      for (const city of [null, ...CITIES.map((city) => city.name)] as const) {
        const params = toInsightsSearchParams({
          filterType,
          signalInterestsEntities: anchorIds,
          signalLocationQuery: city ?? undefined,
          take: 10,
        });
        const key = `${filterType}|${city ?? "none"}`;
        locations.set(key, await insightsCall(`R2 ${shortType(filterType)} ${city ?? "none"}`, params, 8_000));
      }
      }
    }

    lines.push("", "## R3", "");
    for (const filterType of TYPES) {
      const params = toInsightsSearchParams({
        filterType,
        signalInterestsEntities: LATIN_IDS,
        take: 10,
      });
      params.set("feature.explainability", "true");
      const timeout = filterType === "urn:entity:place" ? PLACE_PROBE_TIMEOUT_MS : 8_000;
      explained.set(
        filterType,
        await insightsCall(`R3 ${shortType(filterType)} explain`, params, timeout),
      );
    }

    lines.push("", "## R4", "");
    for (const strategy of ["s1", "s2", "s3"] as const) {
      if (strategy === "s2" && !allowGeocode) {
        lines.push("S2 skipped: filter.geocode.name was not confirmed for place.");
        continue;
      }
      if (strategy === "s3" && (!allowPoint || !allowRadius)) {
        lines.push("S3 skipped: point format or radius unit was not confirmed.");
        continue;
      }
      for (const city of CITIES) {
        for (const withAnchors of [true, false]) {
          const params = toInsightsSearchParams({
            filterType: "urn:entity:place",
            signalInterestsEntities: withAnchors ? anchorIds : undefined,
            take: 10,
            signalLocationQuery: strategy === "s1" ? city.name : undefined,
          });
          if (strategy === "s2") {
            params.set("filter.geocode.name", city.name);
            if (allowCountry) params.set("filter.geocode.country_code", "US");
          }
          if (strategy === "s3") {
            params.set("filter.location", `POINT(${city.lon} ${city.lat})`);
            params.set("filter.location.radius", String(RADIUS_METERS));
          }
          const result = await insightsCall(
            `R4 ${strategy} ${city.name} ${withAnchors ? "anchors" : "open"}`,
            params,
            PLACE_PROBE_TIMEOUT_MS,
          );
          places.push({ strategy, city: city.name, anchors: withAnchors, result });
        }
      }
    }

    lines.push("", "## R5", "");
    const queries = [
      { query: "Cerveza Gallo", type: "urn:entity:brand" },
      { query: "Gallo beer", type: "urn:entity:brand" },
      { query: "Gallo Guatemala", type: "urn:entity:brand" },
      { query: "Gaby Moreno", type: "urn:entity:artist" },
    ];
    for (const item of queries) {
      const result = await call(`R5 ${item.query}`, async () => {
        const response = await search({ query: item.query, type: item.type });
        return { status: 200, body: { results: { entities: response.results.map((entity) => entity.raw) } } };
      });
      const firstRaw = result.ok ? result.raw : null;
      const firstEntity = hitsFromBody(firstRaw)[0];
      const rawList =
        firstRaw && typeof firstRaw === "object"
          ? ((firstRaw as { results?: { entities?: unknown[] } }).results?.entities ?? [])
          : [];
      const first = rawList[0];
      const propertyKeys =
        first && typeof first === "object" && (first as { properties?: unknown }).properties &&
        typeof (first as { properties?: unknown }).properties === "object"
          ? Object.keys((first as { properties: Record<string, unknown> }).properties)
          : [];
      searches.push({
        query: item.query,
        type: item.type,
        result,
        propertyKeys,
        hasTags: Boolean(firstEntity && firstEntity.tags.length > 0),
      });
    }
  } catch (error) {
    aborted = error instanceof Error ? error.message.split(apiKey).join("[redacted]") : "aborted";
    lines.push("", "## Abort", "", aborted);
  }

  const derived = derive({ roots, variants, places, searches });
  lines.push(...renderFull({ roots, variants, locations, explained, places, searches, derived, calls }));
  const share = renderShare({ roots, variants, locations, explained, places, searches, derived, calls, docs, aborted });
  await mkdir("docs/gates", { recursive: true });
  await mkdir("src/lib/pipeline", { recursive: true });
  await writeFile("docs/gates-round2.md", `${lines.join("\n")}\n`);
  await writeFile("docs/gates-round2-share.md", share);
  await writeFile("src/lib/pipeline/config.ts", renderConfig(derived));
  console.log(`calls=${calls} strategy=${derived.placeStrategy} bridge=${derived.bridgeVariant} review=${derived.needsReview}`);
}

type Derived = ReturnType<typeof derive>;

function derive(input: {
  roots: Map<string, CallResult>;
  variants: Map<string, { a: CallResult; b: CallResult; c: CallResult }>;
  places: { strategy: string; city: string; anchors: boolean; result: CallResult }[];
  searches: { query: string; type: string; result: CallResult }[];
}) {
  const strategyScore = (strategy: string) => {
    const rows = input.places.filter((row) => row.strategy === strategy && row.anchors);
    const ok = rows.filter((row) => row.result.ok && row.result.hits.length >= 3 && row.result.ms <= 15_000);
    const slow = rows.some((row) => row.result.ok && row.result.ms > 8_000);
    return { rows: rows.length, ok: ok.length, slow, pass: rows.length === 3 && ok.length === 3 };
  };
  const s1 = strategyScore("s1");
  const s2 = strategyScore("s2");
  const s3 = strategyScore("s3");
  const placeStrategy = s1.pass ? "s1" : s2.pass ? "s2" : s3.pass ? "s3" : "none";
  const chosen = placeStrategy === "s1" ? s1 : placeStrategy === "s2" ? s2 : placeStrategy === "s3" ? s3 : null;
  const placeTimeoutMs = chosen?.slow ? 25_000 : 8_000;

  const ratios = (variant: "a" | "b" | "c") => {
    const values: number[] = [];
    let changed = 0;
    let compared = 0;
    for (const [type, row] of input.variants) {
      const roots = input.roots.get(type);
      if (!roots) continue;
      const current = row[variant];
      if (!current.ok || !row.a.ok) continue;
      compared += 1;
      if (variant !== "a" && idsOf(current).join("|") !== idsOf(row.a).join("|")) changed += 1;
      const overlap = tagOverlap(current, roots);
      if (overlap.bridge > 0) values.push(overlap.shared / overlap.bridge);
    }
    const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    return { mean, changed, compared };
  };
  const a = ratios("a");
  const b = ratios("b");
  const c = ratios("c");
  const qualifies = (row: { mean: number; changed: number; compared: number }) =>
    row.compared > 0 && row.changed * 2 >= row.compared && row.mean > a.mean;
  let bridgeVariant: "a" | "b" | "c" = "a";
  if (qualifies(b) && qualifies(c)) bridgeVariant = b.mean >= c.mean ? "b" : "c";
  else if (qualifies(b)) bridgeVariant = "b";
  else if (qualifies(c)) bridgeVariant = "c";

  const beerCandidates = input.searches
    .filter((search) => search.type === "urn:entity:brand" && search.result.ok)
    .flatMap((search) =>
      search.result.ok
        ? search.result.hits.slice(0, 5).map((hit) => ({ query: search.query, hit }))
        : [],
    )
    .map((candidate) => {
      const beerTags = candidate.hit.tags.filter((tag) => BEER.test(tag));
      const alcoholTags = candidate.hit.tags.filter((tag) => ALCOHOL.test(tag));
      const score = beerTags.length > 0 ? 2 : alcoholTags.length > 0 ? 1 : 0;
      return { ...candidate, beerTags, alcoholTags, score };
    })
    .filter((candidate) => candidate.score > 0 && /gallo/i.test(candidate.hit.name))
    .filter((candidate) => candidate.beerTags.length > 0)
    .sort((left, right) => right.score - left.score);
  const beer = beerCandidates[0] ?? null;

  return {
    placeStrategy,
    placeTimeoutMs,
    bridgeVariant,
    strategies: { s1, s2, s3 },
    ratios: { a, b, c },
    needsReview: !beer,
    beer,
  };
}

function renderFull(input: {
  roots: Map<string, CallResult>;
  variants: Map<string, { a: CallResult; b: CallResult; c: CallResult }>;
  locations: Map<string, CallResult>;
  explained: Map<string, CallResult>;
  places: { strategy: string; city: string; anchors: boolean; result: CallResult }[];
  searches: { query: string; result: CallResult; propertyKeys: string[]; hasTags: boolean }[];
  derived: Derived;
  calls: number;
}): string[] {
  const lines: string[] = ["", `Calls: ${input.calls}`, ""];
  for (const type of TYPES) {
    const root = input.roots.get(type);
    lines.push(`### ${shortType(type)} roots`);
    lines.push(root ? summarize(root) : "missing");
    const row = input.variants.get(type);
    if (!row || !root) continue;
    for (const variant of ["a", "b", "c"] as const) {
      const overlap = tagOverlap(row[variant], root);
      lines.push(
        `- ${variant}: ${summarize(row[variant])}; tag overlap ${overlap.shared}/${overlap.bridge}`,
      );
    }
    lines.push(
      `- id overlap a/b ${sharedIds(idsOf(row.a), idsOf(row.b))}, a/c ${sharedIds(idsOf(row.a), idsOf(row.c))}, b/c ${sharedIds(idsOf(row.b), idsOf(row.c))}`,
    );
  }
  lines.push("", "### R2");
  for (const [key, result] of input.locations) {
    lines.push(`- ${key}: ${summarize(result)}`);
  }
  lines.push("", "### R3");
  for (const type of TYPES) {
    const plain = input.roots.get(type);
    const extra = input.explained.get(type);
    lines.push(`- ${shortType(type)} without status ${plain?.ok ? plain.status : plain?.status ?? "n/a"}`);
    lines.push(`query: ${JSON.stringify(truncate(plain?.ok ? plain.query : null, 3072))}`);
    lines.push(`tags: ${(plain?.ok ? plain.hits.slice(0, 3) : []).map((hit) => `${hit.name}: ${hit.tags.slice(0, 8).join(", ")}`).join(" | ")}`);
    lines.push(`- ${shortType(type)} with status ${extra?.ok ? extra.status : extra?.status ?? "n/a"}`);
    lines.push(`query: ${JSON.stringify(truncate(extra?.ok ? extra.query : null, 3072))}`);
  }
  lines.push("", "### R4");
  for (const row of input.places) {
    lines.push(`- ${row.strategy} ${row.city} anchors=${row.anchors}: ${summarize(row.result)}`);
  }
  lines.push("", "### R5");
  for (const search of input.searches) {
    const hits = search.result.ok ? search.result.hits.slice(0, 5) : [];
    lines.push(`- ${search.query} status ${search.result.status} tags=${search.hasTags} properties=${search.propertyKeys.join(", ") || "(none)"}`);
    for (const hit of hits) lines.push(`  - ${hit.name} | ${hit.id} | ${hit.tags.slice(0, 8).join(", ")}`);
  }
  lines.push("", "### Derived", JSON.stringify(redact(input.derived)));
  return lines;
}

function summarize(result: CallResult): string {
  if (!result.ok) return `status ${result.status} ${result.ms}ms ${result.detail ?? ""}`.trim();
  return `status ${result.status} ${result.ms}ms count ${result.hits.length}; ${topNames(result).join(", ")}`;
}

function renderShare(input: {
  roots: Map<string, CallResult>;
  variants: Map<string, { a: CallResult; b: CallResult; c: CallResult }>;
  locations: Map<string, CallResult>;
  explained: Map<string, CallResult>;
  places: { strategy: string; city: string; anchors: boolean; result: CallResult }[];
  searches: { query: string; result: CallResult; propertyKeys: string[]; hasTags: boolean }[];
  derived: Derived;
  calls: number;
  docs: string;
  aborted: string | null;
}): string {
  const lines = ["# DropQ round 2 (share)", "", `Calls: ${input.calls}`, "", "## R1 Bridge", ""];
  lines.push("| Type | a | b | c | id overlap a/b a/c b/c | tag overlap a b c | identical |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const type of TYPES) {
    const root = input.roots.get(type);
    const row = input.variants.get(type);
    if (!root || !row) {
      lines.push(`| ${shortType(type)} | n/a | n/a | n/a | n/a | n/a | n/a |`);
      continue;
    }
    const tags = (["a", "b", "c"] as const).map((variant) => {
      const overlap = tagOverlap(row[variant], root);
      return overlap.bridge === 0 ? "n/a" : `${overlap.shared}/${overlap.bridge}`;
    });
    const identical = [
      idsOf(row.a).join("|") === idsOf(row.b).join("|") ? "a=b" : "",
      idsOf(row.a).join("|") === idsOf(row.c).join("|") ? "a=c" : "",
      idsOf(row.b).join("|") === idsOf(row.c).join("|") ? "b=c" : "",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(
      `| ${shortType(type)} | ${topNames(row.a).join(", ") || summarize(row.a)} | ${topNames(row.b).join(", ") || summarize(row.b)} | ${topNames(row.c).join(", ") || summarize(row.c)} | ${sharedIds(idsOf(row.a), idsOf(row.b))} ${sharedIds(idsOf(row.a), idsOf(row.c))} ${sharedIds(idsOf(row.b), idsOf(row.c))} | ${tags.join(" ")} | ${identical || "none"} |`,
    );
  }
  lines.push("", "## R2 Location", "");
  for (const filterType of ["urn:entity:brand", "urn:entity:movie"]) {
    const parts = [null, ...CITIES.map((city) => city.name)].map((city) => {
      const result = input.locations.get(`${filterType}|${city ?? "none"}`);
      return `${city ?? "none"}: ${result ? topNames(result).join(", ") || summarize(result) : "missing"}`;
    });
    lines.push(`- ${shortType(filterType)}: ${parts.join(" || ")}`);
  }
  lines.push("", "## R3 Evidence", "");
  for (const type of TYPES) {
    const plain = input.roots.get(type);
    const extra = input.explained.get(type);
    const queryKeys = (value: CallResult | undefined) =>
      value?.ok && value.query && typeof value.query === "object" ? Object.keys(value.query).join(", ") : "(none)";
    const tags = plain?.ok
      ? plain.hits
          .slice(0, 3)
          .map((hit) => `${hit.name} [${hit.tags.slice(0, 6).join(", ")}]`)
          .join("; ")
      : "(none)";
    lines.push(
      `- ${shortType(type)}: without keys ${queryKeys(plain)}; with status ${extra?.status ?? "n/a"} keys ${queryKeys(extra)}; tags ${tags}`,
    );
  }
  const searchTags = input.searches.filter((search) => search.hasTags).length;
  lines.push(`- Search rows with tags: ${searchTags}/${input.searches.length}.`);
  lines.push("", "## R4 Places", "");
  lines.push("| Strategy | City | Anchors | Status | ms | Count | Top 5 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of input.places) {
    lines.push(
      `| ${row.strategy} | ${row.city} | ${row.anchors ? "yes" : "no"} | ${row.result.status} | ${row.result.ms} | ${row.result.ok ? row.result.hits.length : 0} | ${topNames(row.result).join(", ")} |`,
    );
  }
  lines.push("", "## R5 Anchors", "");
  for (const search of input.searches) {
    const hits = search.result.ok ? search.result.hits.slice(0, search.query === "Gaby Moreno" ? 3 : 5) : [];
    lines.push(
      `- ${search.query}: ${hits.map((hit) => `${hit.name} (${hit.id}) [${hit.tags.slice(0, 4).join(", ")}]`).join("; ") || summarize(search.result)}`,
    );
  }
  lines.push("- Round-1 resolved names: Ricardo Arjona; Pollo Campero; Yonezu Kenshi.");
  lines.push("", "## Derived", "");
  lines.push(`- PLACE_STRATEGY=${input.derived.placeStrategy}. S1 ${input.derived.strategies.s1.ok}/3, S2 ${input.derived.strategies.s2.ok}/3, S3 ${input.derived.strategies.s3.ok}/3 within 15s and at least 3 results, with anchors.`);
  lines.push(`- PLACE_TIMEOUT_MS=${input.derived.placeTimeoutMs}.`);
  lines.push(
    `- BRIDGE_VARIANT=${input.derived.bridgeVariant}. Mean tag overlap a=${input.derived.ratios.a.mean.toFixed(2)} b=${input.derived.ratios.b.mean.toFixed(2)} c=${input.derived.ratios.c.mean.toFixed(2)}.`,
  );
  lines.push(
    `- Roots GT needsReview=${input.derived.needsReview}. Beer candidate: ${input.derived.beer ? `${input.derived.beer.hit.name} via ${input.derived.beer.query}` : "none"}.`,
  );
  lines.push(`- Docs: ${input.docs}`);
  lines.push(`- Radius used for S3: ${RADIUS_METERS} meters. Docs state meters and do not give an example value.`);
  if (input.aborted) lines.push(`- Aborted: ${input.aborted}`);
  const text = `${lines.join("\n")}\n`;
  return text.split("\n").length > 150 ? `${lines.slice(0, 145).join("\n")}\n` : text;
}

function renderConfig(derived: Derived): string {
  const gallo = derived.beer
    ? {
        rawText: derived.beer.query,
        entityId: derived.beer.hit.id,
        resolvedName: derived.beer.hit.name,
      }
    : { rawText: "Gallo", entityId: null, resolvedName: null };
  const seed = (
    rawText: string,
    type: string,
    entityId: string | null,
    resolvedName: string | null,
  ) =>
    `    { rawText: ${JSON.stringify(rawText)}, type: ${JSON.stringify(type)}, entityId: ${entityId ? JSON.stringify(entityId) : "null"}, resolvedName: ${resolvedName ? JSON.stringify(resolvedName) : "null"} },`;
  return `export const PLACE_STRATEGY = ${JSON.stringify(derived.placeStrategy)} as const;
export const PLACE_TIMEOUT_MS = ${derived.placeTimeoutMs};
export const BRIDGE_VARIANT = ${JSON.stringify(derived.bridgeVariant)} as const;
export const USE_EXPLAINABILITY = true;

export type PinnedSeed = {
  rawText: string;
  type: string;
  entityId: string | null;
  resolvedName: string | null;
};

export type PinnedPreset = {
  id: "roots-gt-la" | "latin-tour-houston" | "fandom-con-nyc";
  needsReview: boolean;
  city: "Los Angeles" | "Houston" | "New York";
  eventKind: "comunidad" | "tour" | "con";
  seeds: readonly PinnedSeed[];
};

export const PINNED_PRESETS: readonly PinnedPreset[] = [
  {
    id: "roots-gt-la",
    needsReview: ${derived.needsReview},
    city: "Los Angeles",
    eventKind: "comunidad",
    seeds: [
${seed("Ricardo Arjona", "urn:entity:artist", "CA98034C-6AD8-44AA-898E-038495C4E116", "Ricardo Arjona")}
${seed("Pollo Campero", "urn:entity:brand", "A5332654-C9F6-43B6-9A00-D0AE2BF8B20C", "Pollo Campero")}
${seed(gallo.rawText, "urn:entity:brand", gallo.entityId, gallo.resolvedName)}
    ],
  },
  {
    id: "latin-tour-houston",
    needsReview: false,
    city: "Houston",
    eventKind: "tour",
    seeds: [
${seed("Bad Bunny", "urn:entity:artist", "BDA1B73F-10E7-4D09-AC51-B796CCEC5FF3", "Bad Bunny")}
${seed("Karol G", "urn:entity:artist", "658495BB-DF77-472E-A6B2-9E37FF248FB3", "Karol G")}
${seed("Nike", "urn:entity:brand", "C70CE2B8-0AD1-4150-BF18-5A6347F2E860", "Nike")}
    ],
  },
  {
    id: "fandom-con-nyc",
    needsReview: false,
    city: "New York",
    eventKind: "con",
    seeds: [
${seed("Chainsaw Man", "urn:entity:tv_show", "042EB535-51B0-4DCF-8B33-1A3466952A56", "Chainsaw Man")}
${seed("Kenshi Yonezu", "urn:entity:artist", "59992D0D-01F0-40EB-B587-05DC21051175", "Yonezu Kenshi")}
${seed("Uniqlo", "urn:entity:brand", "46C9F889-EC89-4715-A767-DEABACF52C41", "Uniqlo")}
    ],
  },
];
`;
}

void main();

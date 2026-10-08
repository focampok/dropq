import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { enableSmokeGuards, qlooGet, search, tags } from "../src/lib/qloo/client";
import { resolveQlooBaseUrl } from "../src/lib/qloo/config";
import { toInsightsSearchParams } from "../src/lib/qloo/params";
import { QlooGuardError, QlooHttpError, type InsightEntityType } from "../src/lib/qloo/types";

if (existsSync(".env")) loadEnvFile(".env");

const apiKey = process.env.QLOO_API_KEY?.trim() ?? "";
if (!apiKey) {
  console.log("skipped_no_key");
  process.exit(0);
}

const CALL_CAP = 45;
const PLACE_TIMEOUT_MS = 12_000;
const RADIUS_METERS = 20_000;
const GABY_ID = "27B180A1-3E0A-4340-81A3-57FB51816E2D";
const LATIN_IDS = [
  "BDA1B73F-10E7-4D09-AC51-B796CCEC5FF3",
  "658495BB-DF77-472E-A6B2-9E37FF248FB3",
  "C70CE2B8-0AD1-4150-BF18-5A6347F2E860",
];
const CON_IDS = [
  "042EB535-51B0-4DCF-8B33-1A3466952A56",
  "59992D0D-01F0-40EB-B587-05DC21051175",
  "46C9F889-EC89-4715-A767-DEABACF52C41",
];
const ARJONA = "CA98034C-6AD8-44AA-898E-038495C4E116";
const CAMPERO = "A5332654-C9F6-43B6-9A00-D0AE2BF8B20C";
const CITIES = [
  { name: "Los Angeles", lat: 34.0522, lon: -118.2437 },
  { name: "Houston", lat: 29.7604, lon: -95.3698 },
  { name: "New York", lat: 40.7128, lon: -74.006 },
] as const;
const TAG_QUERIES = [
  "nightlife",
  "live music",
  "music venue",
  "bar",
  "nightclub",
  "restaurant",
  "cafe",
  "theater",
  "entertainment",
  "museum",
];
const LODGING = ["hotel", "lodging", "resort", "motel", "inn", "suites"];
const CAPS = [0.9, 0.8, 0.6] as const;
const BRIDGE_TYPES: InsightEntityType[] = ["urn:entity:artist", "urn:entity:brand", "urn:entity:tv_show"];

type Hit = { id: string; name: string; tags: string[] };
type CallOk = { ok: true; status: number; ms: number; hits: Hit[] };
type CallFail = { ok: false; status: number; ms: number; detail?: string };
type CallResult = CallOk | CallFail;
type TagRow = { id: string; name: string; types: string[]; subtype: string };
type PlaceRow = {
  setId: string;
  city: string;
  anchors: boolean;
  result: CallResult;
  lodging: number;
};
type Kind = "tour" | "con" | "comunidad";

let calls = 0;
let parentsTypes: string | undefined = "urn:entity:place";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tagNames(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const tagsValue = (value as { tags?: unknown }).tags;
  if (!Array.isArray(tagsValue)) return [];
  return tagsValue.flatMap((tag) => {
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

function httpDetail(error: unknown): string | undefined {
  if (!(error instanceof QlooHttpError) || !("detail" in error)) return undefined;
  const detail = (error as { detail?: unknown }).detail;
  return typeof detail === "string" ? detail.split(apiKey).join("[redacted]") : undefined;
}

async function call(
  label: string,
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<CallResult> {
  if (calls >= CALL_CAP) throw new QlooGuardError("Qloo call cap reached");
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
    return { ok: true, status: value.status, ms, hits: hitsFromBody(value.body) };
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

async function insightsCall(label: string, params: URLSearchParams, timeoutMs: number): Promise<CallResult> {
  return call(label, async () => {
    const response = await qlooGet("/v2/insights", params, timeoutMs);
    return { status: response.status, body: response.body };
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function tagRowsFrom(raw: unknown): TagRow[] {
  const record = asRecord(raw);
  const results = record?.results;
  const list = Array.isArray(results)
    ? results
    : asRecord(results) && Array.isArray(asRecord(results)?.tags)
      ? (asRecord(results)?.tags as unknown[])
      : [];
  return list.flatMap((entry) => {
    const tag = asRecord(entry);
    if (!tag) return [];
    const id = typeof tag.tag_id === "string" ? tag.tag_id : typeof tag.id === "string" ? tag.id : "";
    const name = typeof tag.name === "string" ? tag.name : "";
    if (!id && !name) return [];
    const types = Array.isArray(tag.types) ? tag.types.filter((item): item is string => typeof item === "string") : [];
    const subtype = typeof tag.subtype === "string" ? tag.subtype : "";
    return [{ id: id || name, name, types, subtype }];
  });
}

function isPlaceTag(tag: TagRow): boolean {
  if (tag.types.some((type) => type === "urn:entity:place")) return true;
  return tag.id.toLowerCase().includes(":place");
}

function scoreTag(tag: TagRow, query: string): number {
  const name = tag.name.toLowerCase();
  const wanted = query.toLowerCase();
  let score = 0;
  if (name === wanted) score += 100;
  else if (name.includes(wanted)) score += 70;
  else if (wanted.split(" ").every((word) => name.includes(word))) score += 55;
  else score += 5;
  if (tag.types.includes("urn:entity:place")) score += 30;
  if (tag.subtype.toLowerCase().includes("place")) score += 20;
  if (/category|genre|amenity|cuisine/.test(tag.subtype.toLowerCase())) score += 8;
  return score;
}

function topNames(result: CallResult, count = 5): string[] {
  if (!result.ok) return [];
  return result.hits.slice(0, count).map((hit) => hit.name || hit.id);
}

function idsOf(result: CallResult, count = 10): string[] {
  return result.ok ? result.hits.slice(0, count).map((hit) => hit.id) : [];
}

function sharedIds(left: string[], right: string[]): number {
  const set = new Set(right);
  return left.filter((id) => set.has(id)).length;
}

function isLodging(tagsOnHit: string[]): boolean {
  return tagsOnHit.some((tag) => {
    const lower = tag.toLowerCase();
    return LODGING.some((word) => lower.includes(word));
  });
}

function lodgingShare(result: CallResult): number {
  if (!result.ok || result.hits.length === 0) return 1;
  const lodging = result.hits.filter((hit) => isLodging(hit.tags)).length;
  return lodging / result.hits.length;
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

function summarize(result: CallResult): string {
  if (!result.ok) return `status ${result.status} ${result.ms}ms ${result.detail ?? ""}`.trim();
  return `status ${result.status} ${result.ms}ms count ${result.hits.length}`;
}

function placeParams(city: (typeof CITIES)[number], urns: string[], anchorIds: string[] | undefined) {
  return toInsightsSearchParams({
    filterType: "urn:entity:place",
    signalInterestsEntities: anchorIds,
    filterTags: urns,
    filterLocation: `POINT(${city.lon} ${city.lat})`,
    filterLocationRadius: RADIUS_METERS,
    take: 10,
  });
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
  let aborted: string | null = null;
  const found = new Map<string, TagRow[]>();
  const chosen = new Map<string, TagRow | null>();
  const places: PlaceRow[] = [];
  const roots = new Map<string, CallResult>();
  const baseline = new Map<string, CallResult>();
  const capped = new Map<string, CallResult>();
  const kindPlaces: { kind: Kind; city: string; anchors: boolean; setId: string; result: CallResult; lodging: number }[] = [];
  const kindBridge: { kind: Kind; slot: string; result: CallResult }[] = [];
  let gaby: CallResult | null = null;
  let gabyVerified = false;
  let bridgeAnchors: { id: string; name: string; type: string }[] = [];

  try {
    gaby = await call("R0 Gaby Moreno", async () => {
      const response = await search({ query: "Gaby Moreno", type: "urn:entity:artist" });
      return {
        status: 200,
        body: { results: { entities: response.results.map((entity) => entity.raw) } },
      };
    });
    gabyVerified = Boolean(gaby.ok && gaby.hits.some((hit) => hit.id.toUpperCase() === GABY_ID));

    for (const query of TAG_QUERIES) {
      let raw: unknown = null;
      const result = await call(`R6 ${query}`, async () => {
        const response = await tags({ query, parentsTypes });
        raw = response.raw ?? { results: { tags: response.results.map((tag) => tag.raw) } };
        return { status: 200, body: { results: { entities: [] } } };
      });
      if (!result.ok && result.status === 400 && parentsTypes) {
        parentsTypes = undefined;
        raw = null;
        const retry = await call(`R6 ${query} retry`, async () => {
          const response = await tags({ query });
          raw = response.raw ?? { results: { tags: response.results.map((tag) => tag.raw) } };
          return { status: 200, body: { results: { entities: [] } } };
        });
        found.set(query, retry.ok ? tagRowsFrom(raw) : []);
        continue;
      }
      found.set(query, result.ok ? tagRowsFrom(raw) : []);
    }
  } catch (error) {
    aborted = error instanceof Error ? error.message.split(apiKey).join("[redacted]") : "aborted";
  }

  for (const query of TAG_QUERIES) {
    const rows = (found.get(query) ?? []).filter(isPlaceTag);
    const best = [...rows].sort((left, right) => scoreTag(right, query) - scoreTag(left, query))[0] ?? null;
    chosen.set(query, best);
  }

  const urn = (query: string) => chosen.get(query)?.id ?? null;
  const sets: { id: string; label: string; urns: string[]; kinds: Kind[] }[] = [];
  const live = [urn("live music") ?? urn("music venue"), urn("nightlife") ?? urn("nightclub")].filter(
    (value): value is string => Boolean(value),
  );
  const table = [urn("restaurant"), urn("bar") ?? urn("cafe")].filter((value): value is string => Boolean(value));
  const show = [urn("entertainment") ?? urn("museum"), urn("theater") ?? urn("nightlife")].filter(
    (value): value is string => Boolean(value),
  );
  if (live.length) sets.push({ id: "live-night", label: "live music + nightlife", urns: [...new Set(live)], kinds: ["tour"] });
  if (table.length) sets.push({ id: "restaurant-bar", label: "restaurant + bar", urns: [...new Set(table)], kinds: ["comunidad"] });
  if (show.length) sets.push({ id: "show", label: "entertainment + theater", urns: [...new Set(show)], kinds: ["con"] });

  const gabyId = gabyVerified ? GABY_ID : gaby?.ok ? gaby.hits[0]?.id ?? GABY_ID : GABY_ID;
  const comunidadIds = [ARJONA, CAMPERO, gabyId];

  try {
    if (aborted) throw new QlooGuardError(aborted);
    const matrix = sets.filter((set) => set.id !== "show").slice(0, 2);
    for (const set of matrix) {
      for (const city of CITIES) {
        for (const withAnchors of [true, false]) {
          const result = await insightsCall(
            `R7 ${set.id} ${city.name} ${withAnchors ? "anchors" : "open"}`,
            placeParams(city, set.urns, withAnchors ? LATIN_IDS : undefined),
            PLACE_TIMEOUT_MS,
          );
          places.push({ setId: set.id, city: city.name, anchors: withAnchors, result, lodging: lodgingShare(result) });
        }
      }
    }

    for (const filterType of BRIDGE_TYPES) {
      roots.set(
        filterType,
        await insightsCall(
          `R8 roots ${shortType(filterType)}`,
          toInsightsSearchParams({ filterType, signalInterestsEntities: LATIN_IDS, take: 10 }),
          8_000,
        ),
      );
    }
    for (const filterType of BRIDGE_TYPES) {
      const hit = roots.get(filterType);
      const first = hit?.ok ? hit.hits[0] : undefined;
      if (first) bridgeAnchors.push({ id: first.id, name: first.name, type: filterType });
    }
    const anchorIds = bridgeAnchors.map((anchor) => anchor.id);
    if (anchorIds.length >= 2) {
      for (const filterType of BRIDGE_TYPES) {
        const rootIds = idsOf(roots.get(filterType) ?? { ok: false, status: 0, ms: 0 });
        const base = toInsightsSearchParams({
          filterType,
          signalInterestsEntities: anchorIds,
          signalLocationQuery: "Houston",
          filterExcludeEntities: rootIds,
          take: 10,
        });
        baseline.set(filterType, await insightsCall(`R8 a ${shortType(filterType)}`, base, 8_000));
        for (const cap of CAPS) {
          const params = new URLSearchParams(base);
          params.set("filter.popularity.max", String(cap));
          capped.set(
            `${filterType}|${cap}`,
            await insightsCall(`R8 ${cap} ${shortType(filterType)}`, params, 8_000),
          );
        }
      }
    }

    const conSet = sets.find((set) => set.id === "show") ?? sets[0];
    const foodSet = sets.find((set) => set.id === "restaurant-bar") ?? sets[0];
    const bridges: { kind: Kind; city: string; ids: string[]; slot: "listen" | "wear"; type: InsightEntityType }[] = [
      { kind: "con", city: "New York", ids: CON_IDS, slot: "listen", type: "urn:entity:artist" },
      { kind: "con", city: "New York", ids: CON_IDS, slot: "wear", type: "urn:entity:brand" },
      { kind: "comunidad", city: "Los Angeles", ids: comunidadIds, slot: "listen", type: "urn:entity:artist" },
      { kind: "comunidad", city: "Los Angeles", ids: comunidadIds, slot: "wear", type: "urn:entity:brand" },
    ];
    for (const item of bridges) {
      if (calls >= CALL_CAP) break;
      const result = await insightsCall(
        `R9 ${item.kind} ${item.slot}`,
        toInsightsSearchParams({
          filterType: item.type,
          signalInterestsEntities: item.ids,
          signalLocationQuery: item.city,
          take: 10,
        }),
        8_000,
      );
      kindBridge.push({ kind: item.kind, slot: item.slot, result });
    }
    if (conSet) {
      for (const city of CITIES) {
        if (calls >= CALL_CAP) break;
        const result = await insightsCall(
          `R9 con ${city.name}`,
          placeParams(city, conSet.urns, CON_IDS),
          PLACE_TIMEOUT_MS,
        );
        kindPlaces.push({
          kind: "con",
          city: city.name,
          anchors: true,
          setId: conSet.id,
          result,
          lodging: lodgingShare(result),
        });
      }
    }
    if (foodSet && calls < CALL_CAP) {
      const la = CITIES[0];
      const result = await insightsCall(
        "R9 comunidad Los Angeles",
        placeParams(la, foodSet.urns, comunidadIds),
        PLACE_TIMEOUT_MS,
      );
      kindPlaces.push({
        kind: "comunidad",
        city: la.name,
        anchors: true,
        setId: foodSet.id,
        result,
        lodging: lodgingShare(result),
      });
    }
  } catch (error) {
    aborted = error instanceof Error ? error.message.split(apiKey).join("[redacted]") : "aborted";
  }

  const derived = derive({ sets, places, kindPlaces, roots, baseline, capped });
  const full = renderFull({
    host: baseHost,
    found,
    chosen,
    sets,
    places,
    roots,
    baseline,
    capped,
    bridgeAnchors,
    kindPlaces,
    kindBridge,
    gaby,
    gabyVerified,
    gabyId,
    derived,
    aborted,
  });
  const share = renderShare({
    found,
    chosen,
    sets,
    places,
    roots,
    baseline,
    capped,
    kindPlaces,
    kindBridge,
    gaby,
    gabyVerified,
    derived,
    aborted,
  });
  await mkdir("docs", { recursive: true });
  await writeFile("docs/gates-round3.md", full);
  await writeFile("docs/gates-round3-share.md", share);
  console.log(
    `calls=${calls} anchors=${derived.useAnchors} cap=${derived.cap} aborted=${aborted ?? "no"} tags=${JSON.stringify(derived.placeTags)}`,
  );
}

function cityStats(
  rows: { city: string; anchors: boolean; result: CallResult; lodging: number }[],
  anchors: boolean,
) {
  const picked = CITIES.map((city) => rows.find((row) => row.city === city.name && row.anchors === anchors)).filter(
    (row): row is { city: string; anchors: boolean; result: CallResult; lodging: number } => Boolean(row),
  );
  if (picked.length < 3) return null;
  const ready = picked.every((row) => row.result.ok && row.result.hits.length >= 5);
  if (!ready) return null;
  const lodging = picked.reduce((sum, row) => sum + row.lodging, 0) / picked.length;
  const latency = picked.reduce((sum, row) => sum + row.result.ms, 0) / picked.length;
  return { lodging, latency, picked };
}

function derive(input: {
  sets: { id: string; label: string; urns: string[]; kinds: Kind[] }[];
  places: PlaceRow[];
  kindPlaces: { kind: Kind; city: string; anchors: boolean; setId: string; result: CallResult; lodging: number }[];
  roots: Map<string, CallResult>;
  baseline: Map<string, CallResult>;
  capped: Map<string, CallResult>;
}) {
  const placeTags: Record<Kind, string[] | null> = { tour: null, con: null, comunidad: null };
  const notes: Record<Kind, string> = { tour: "", con: "", comunidad: "" };
  let useAnchors = false;
  const anchorPasses: boolean[] = [];

  for (const kind of ["tour", "con", "comunidad"] as const) {
    const candidates = input.sets.filter((set) => set.kinds.includes(kind) || kind === "tour");
    const pool = kind === "tour" ? input.sets.filter((set) => set.kinds.includes("tour") || set.id !== "show") : candidates;
    const ranked = pool
      .map((set) => {
        const rows = [
          ...input.places.filter((row) => row.setId === set.id),
          ...input.kindPlaces.filter((row) => row.setId === set.id && row.kind === kind),
        ];
        const stats = cityStats(rows, true);
        return stats ? { set, ...stats } : null;
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .sort((left, right) => left.lodging - right.lodging || left.latency - right.latency);
    const winner = ranked.find((row) => row.lodging < 0.3) ?? null;
    placeTags[kind] = winner ? winner.set.urns : null;
    notes[kind] = winner
      ? `${winner.set.label} lodging ${(winner.lodging * 100).toFixed(0)}% latency ${Math.round(winner.latency)}ms`
      : "no set under 30% lodging with 5 results in all three cities";
    if (winner) anchorPasses.push(true);
  }

    const chosenUrns = (["tour", "con", "comunidad"] as const).flatMap((kind) => placeTags[kind] ?? []);
  if (chosenUrns.length > 0) {
    useAnchors = (["tour", "con", "comunidad"] as const).every((kind) => {
      const urns = placeTags[kind];
      if (!urns) return true;
      const set = input.sets.find((item) => item.urns.join("|") === urns.join("|"));
      if (!set) return false;
      const rows = [
        ...input.places.filter((row) => row.setId === set.id),
        ...input.kindPlaces.filter((row) => row.setId === set.id),
      ];
      const stats = cityStats(rows, true);
      return Boolean(stats && stats.lodging < 0.3);
    });
  }

  let cap = 0.8;
  const capNotes: string[] = [];
  for (const value of CAPS) {
    let differing = 0;
    for (const type of BRIDGE_TYPES) {
      const base = input.baseline.get(type);
      const next = input.capped.get(`${type}|${value}`);
      if (!base?.ok || !next?.ok) continue;
      const differ = idsOf(next).filter((id) => !idsOf(base).includes(id)).length;
      const overlap = tagOverlap(next, input.roots.get(type) ?? { ok: false, status: 0, ms: 0 });
      capNotes.push(
        `${value} ${shortType(type)} differ ${differ}/10 shared ${sharedIds(idsOf(base), idsOf(next))} tag ${overlap.shared}/${overlap.bridge}`,
      );
      if (differ >= 6) differing += 1;
    }
    if (differing >= 2) {
      cap = value;
      break;
    }
  }

  return { placeTags, notes, useAnchors, cap, capNotes, anchorPasses: anchorPasses.length };
}

function renderFull(input: {
  host: string;
  found: Map<string, TagRow[]>;
  chosen: Map<string, TagRow | null>;
  sets: { id: string; label: string; urns: string[]; kinds: Kind[] }[];
  places: PlaceRow[];
  roots: Map<string, CallResult>;
  baseline: Map<string, CallResult>;
  capped: Map<string, CallResult>;
  bridgeAnchors: { id: string; name: string; type: string }[];
  kindPlaces: { kind: Kind; city: string; anchors: boolean; setId: string; result: CallResult; lodging: number }[];
  kindBridge: { kind: Kind; slot: string; result: CallResult }[];
  gaby: CallResult | null;
  gabyVerified: boolean;
  gabyId: string;
  derived: ReturnType<typeof derive>;
  aborted: string | null;
}): string {
  const lines = [
    "# Qloo round 3",
    "",
    `Host: ${input.host}`,
    `Calls: ${calls}`,
    "Tags endpoint: reference/get-tags.md uses filter.query, filter.parents.types, and take.",
    "",
    "## R0 Gaby Moreno",
    "",
    input.gaby
      ? `- status ${input.gaby.status} ${input.gaby.ms}ms verified=${input.gabyVerified} id=${input.gabyId}`
      : "- missing",
    input.gaby?.ok
      ? `- top: ${input.gaby.hits.slice(0, 3).map((hit) => `${hit.name} (${hit.id})`).join("; ")}`
      : "",
    "",
    "## R6 Place categories",
    "",
  ];
  for (const query of TAG_QUERIES) {
    const rows = (input.found.get(query) ?? []).filter(isPlaceTag).slice(0, 3);
    const pick = input.chosen.get(query);
    lines.push(`### ${query}`);
    if (rows.length === 0) lines.push("- no place tag");
    for (const row of rows) {
      lines.push(`- ${row.name} | ${row.id} | parents ${row.types.filter((type) => type.includes("place")).join(", ") || row.types.slice(0, 3).join(", ") || "(none)"} | ${row.subtype || "(no subtype)"}`);
    }
    lines.push(`- picked: ${pick ? `${pick.name} ${pick.id}` : "none"}`);
  }
  lines.push("", "## R7 Place + category", "");
  for (const row of input.places) {
    const names = topNames(row.result, 10).join(", ");
    lines.push(
      `- ${row.setId} ${row.city} anchors=${row.anchors}: ${summarize(row.result)} lodging ${(row.lodging * 100).toFixed(0)}% | ${names}`,
    );
  }
  lines.push("", "## R8 Popularity cap", "");
  lines.push(`Anchors: ${input.bridgeAnchors.map((anchor) => `${shortType(anchor.type)} ${anchor.name}`).join("; ") || "(none)"}`);
  for (const type of BRIDGE_TYPES) {
    const root = input.roots.get(type);
    const base = input.baseline.get(type);
    lines.push(`### ${shortType(type)}`);
    lines.push(`- roots: ${root ? `${summarize(root)}; ${topNames(root).join(", ")}` : "missing"}`);
    lines.push(`- a: ${base ? `${summarize(base)}; ${topNames(base).join(", ")}` : "missing"}`);
    for (const cap of CAPS) {
      const result = input.capped.get(`${type}|${cap}`);
      const overlap = result && root ? tagOverlap(result, root) : { shared: 0, bridge: 0 };
      const differ = result && base ? idsOf(result).filter((id) => !idsOf(base).includes(id)).length : 0;
      lines.push(
        `- ${cap}: ${result ? `${summarize(result)}; ${topNames(result).join(", ")}` : "missing"}; differ ${differ}; tag ${overlap.shared}/${overlap.bridge}`,
      );
    }
  }
  lines.push("", "## R9 Event kinds", "");
  for (const row of input.kindPlaces) {
    lines.push(
      `- ${row.kind} ${row.setId} ${row.city} anchors=${row.anchors}: ${summarize(row.result)} lodging ${(row.lodging * 100).toFixed(0)}% | ${topNames(row.result, 10).join(", ")}`,
    );
  }
  for (const row of input.kindBridge) {
    lines.push(`- ${row.kind} ${row.slot}: ${summarize(row.result)}; ${topNames(row.result).join(", ")}`);
  }
  lines.push("", "## Derived", "");
  lines.push(`- PLACE_CATEGORY_TAGS tour=${JSON.stringify(input.derived.placeTags.tour)} (${input.derived.notes.tour})`);
  lines.push(`- PLACE_CATEGORY_TAGS con=${JSON.stringify(input.derived.placeTags.con)} (${input.derived.notes.con})`);
  lines.push(`- PLACE_CATEGORY_TAGS comunidad=${JSON.stringify(input.derived.placeTags.comunidad)} (${input.derived.notes.comunidad})`);
  lines.push(`- PLACE_USE_ANCHORS=${input.derived.useAnchors}`);
  lines.push(`- DEEP_CUTS_POPULARITY_MAX=${input.derived.cap}`);
  lines.push(...input.derived.capNotes.map((note) => `- ${note}`));
  lines.push("- Recognizable cap: pending judgement.");
  if (input.aborted) lines.push(`- Aborted: ${input.aborted}`);
  return `${lines.filter((line) => line !== "").join("\n")}\n`;
}

function renderShare(input: {
  found: Map<string, TagRow[]>;
  chosen: Map<string, TagRow | null>;
  sets: { id: string; label: string; urns: string[] }[];
  places: PlaceRow[];
  roots: Map<string, CallResult>;
  baseline: Map<string, CallResult>;
  capped: Map<string, CallResult>;
  kindPlaces: { kind: Kind; city: string; setId: string; result: CallResult; lodging: number }[];
  kindBridge: { kind: Kind; slot: string; result: CallResult }[];
  gaby: CallResult | null;
  gabyVerified: boolean;
  derived: ReturnType<typeof derive>;
  aborted: string | null;
}): string {
  const lines = ["# DropQ round 3 (share)", "", `Calls: ${calls}`, "", "## R6 Place categories", ""];
  for (const query of TAG_QUERIES) {
    const extra = (input.found.get(query) ?? []).filter(isPlaceTag).slice(0, 2);
    const listed = extra
      .map((row) => {
        const parent = row.types.find((type) => type.includes("place")) ?? (row.subtype || "place");
        return `${row.name} (${row.id}; ${parent})`;
      })
      .join("; ");
    lines.push(`- ${query}: ${listed || "no place tag"}`);
  }
  lines.push("", "## R7 Place + category", "");
  lines.push("| Set | City | Anchors | ms | Count | Lodging | Top 5 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of input.places) {
    lines.push(
      `| ${row.setId} | ${row.city} | ${row.anchors ? "yes" : "no"} | ${row.result.ms} | ${row.result.ok ? row.result.hits.length : 0} | ${(row.lodging * 100).toFixed(0)}% | ${topNames(row.result).join(", ")} |`,
    );
  }
  lines.push("", "## R8 Popularity cap", "");
  lines.push("| Type | a | 0.9 | 0.8 | 0.6 | differ 0.9 0.8 0.6 | tag overlap mean note |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const type of BRIDGE_TYPES) {
    const base = input.baseline.get(type);
    const cells = CAPS.map((cap) => {
      const result = input.capped.get(`${type}|${cap}`);
      return result ? topNames(result).join(", ") || summarize(result) : "missing";
    });
    const differ = CAPS.map((cap) => {
      const result = input.capped.get(`${type}|${cap}`);
      if (!result || !base) return "n/a";
      return String(idsOf(result).filter((id) => !idsOf(base).includes(id)).length);
    });
    const ratios = CAPS.map((cap) => {
      const result = input.capped.get(`${type}|${cap}`);
      const root = input.roots.get(type);
      if (!result || !root) return "n/a";
      const overlap = tagOverlap(result, root);
      return overlap.bridge ? (overlap.shared / overlap.bridge).toFixed(2) : "n/a";
    });
    lines.push(
      `| ${shortType(type)} | ${base ? topNames(base).join(", ") || summarize(base) : "missing"} | ${cells[0]} | ${cells[1]} | ${cells[2]} | ${differ.join(" ")} | ${ratios.join(" ")} |`,
    );
  }
  lines.push("", "## R9 Event kinds", "");
  for (const row of input.kindPlaces) {
    lines.push(
      `- ${row.kind} ${row.setId} ${row.city}: count ${row.result.ok ? row.result.hits.length : 0} ${row.result.ms}ms lodging ${(row.lodging * 100).toFixed(0)}% | ${topNames(row.result).join(", ")}`,
    );
  }
  for (const row of input.kindBridge) {
    lines.push(`- ${row.kind} ${row.slot}: ${topNames(row.result).join(", ") || summarize(row.result)}`);
  }
  lines.push("", "## Gaby Moreno", "");
  lines.push(
    input.gaby?.ok
      ? `- verified=${input.gabyVerified}; ${input.gaby.hits.slice(0, 2).map((hit) => `${hit.name} (${hit.id})`).join("; ")}`
      : `- search ${input.gaby ? summarize(input.gaby) : "missing"}`,
  );
  lines.push("", "## Derived", "");
  lines.push(`- PLACE_CATEGORY_TAGS tour ${JSON.stringify(input.derived.placeTags.tour)} — ${input.derived.notes.tour}`);
  lines.push(`- PLACE_CATEGORY_TAGS con ${JSON.stringify(input.derived.placeTags.con)} — ${input.derived.notes.con}`);
  lines.push(`- PLACE_CATEGORY_TAGS comunidad ${JSON.stringify(input.derived.placeTags.comunidad)} — ${input.derived.notes.comunidad}`);
  lines.push(`- PLACE_USE_ANCHORS=${input.derived.useAnchors}`);
  lines.push(`- DO_EXCLUDE_TAG_KEYWORDS hotel, lodging, resort, motel, inn, suites`);
  lines.push(`- DEEP_CUTS_POPULARITY_MAX=${input.derived.cap}`);
  lines.push("- Recognizable cap: pending judgement.");
  if (input.aborted) lines.push(`- Aborted: ${input.aborted}`);
  const text = `${lines.join("\n")}\n`;
  const count = text.split("\n").length;
  if (count <= 120) return text;
  return `${lines.slice(0, 115).join("\n")}\n`;
}

void main();

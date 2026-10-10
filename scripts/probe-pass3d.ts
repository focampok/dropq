/**
 * Pass 3d probe. It measures, per stage, why the fandom preset's Bridge `do` slot
 * comes back empty, and compares replacement seeds. Reports only; it judges nothing.
 *
 *   pnpm probe:pass3d do          stage counts for the pinned fandom preset
 *   pnpm probe:pass3d candidates  resolve + hop 0 for each candidate preset
 *   pnpm probe:pass3d tags        look for place category tag ids under urn:tag:category:place:*
 */
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { cachedInsights, cachedSearch } from "../src/lib/qloo/cache";
import { enableSmokeGuards, insights, observedQlooCalls, qlooQuota, search, tags } from "../src/lib/qloo/client";
import { anchorsForRule, type AnchorCandidate } from "../src/lib/pipeline/anchors";
import { PINNED_PRESETS, PLACE_CATEGORY_TAGS } from "../src/lib/pipeline/config";
import { fillPlaceSlot, placeStages, type PlaceStages } from "../src/lib/pipeline/place";
import { insightArgs, locationKey, PACK_SLOTS, placeTagSets, type PackSlot } from "../src/lib/pipeline/requests";
import type { InsightsParams, QlooInsightHit } from "../src/lib/qloo/types";

if (existsSync(".env")) loadEnvFile(".env");

const BUDGET = Number(process.env.PROBE_BUDGET ?? 50);
const CITY = "New York";
const FANDOM = PINNED_PRESETS.find((preset) => preset.id === "fandom-con-nyc")!;

type Hit = QlooInsightHit & { tags: string[] };

function tagNames(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as { tags?: unknown }).tags;
  if (!Array.isArray(list)) return [];
  return list.flatMap((tag) => {
    const name = tag && typeof tag === "object" ? (tag as { name?: unknown }).name : undefined;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  });
}

function redact(value: unknown): string {
  const key = process.env.QLOO_API_KEY ?? "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (key ? text.split(key).join("[redacted]") : text).slice(0, 400);
}

async function load(
  slot: PackSlot,
  anchors: string[],
  hop: 0 | 1,
  exclude: string[],
  extra?: Partial<InsightsParams> & { placeRadius?: number },
): Promise<Hit[]> {
  const args = insightArgs({
    slot,
    eventKind: FANDOM.eventKind,
    anchors,
    city: CITY,
    hop,
    exclude,
    placeMode: "city",
    placeRadius: extra?.placeRadius,
  });
  if (!args) return [];
  const merged: InsightsParams = { ...args, ...extra };
  delete (merged as { placeRadius?: number }).placeRadius;
  const result = await cachedInsights(merged, {
    anchors: merged.signalInterestsEntities ?? [],
    filterType: merged.filterType,
    location: locationKey(merged),
    hop,
    variant: hop === 1 ? "a" : "a",
    exclude: merged.filterExcludeEntities ?? [],
  });
  return result.results.map((hit) => ({ ...hit, tags: tagNames(hit.raw) }));
}

function stagesLabel(stages: PlaceStages): string {
  return `raw ${stages.raw}; named ${stages.named}; afterLodging ${stages.afterLodging}; afterRoots ${stages.afterRoots}`;
}

async function seedTagsOf(texts: readonly string[]): Promise<Set<string>> {
  const set = new Set<string>();
  for (const text of texts) {
    const found = await cachedSearch(text);
    for (const tag of tagNames(found.results[0]?.raw)) set.add(tag.toLowerCase());
  }
  return set;
}

async function resolveSeeds(seeds: readonly { rawText: string }[]) {
  const out: { rawText: string; entityId: string | null; name: string; type: string; tags: string[] }[] = [];
  for (const seed of seeds) {
    const found = await cachedSearch(seed.rawText);
    const top = found.results[0];
    out.push({
      rawText: seed.rawText,
      entityId: top?.entityId ?? null,
      name: top?.name ?? "",
      type: top?.type ?? "",
      tags: tagNames(top?.raw),
    });
  }
  return out;
}

async function doStages(roots: Map<PackSlot, Hit[]>, anchorIds: string[]) {
  const rootsIds = new Set((roots.get("do") ?? []).map((hit) => hit.entityId));
  const loadTags = async (tags: string[], radius?: number): Promise<Hit[]> => {
    const args = insightArgs({
      slot: "do",
      eventKind: FANDOM.eventKind,
      anchors: [],
      city: CITY,
      hop: 1,
      exclude: [],
      placeMode: "city",
      placeRadius: radius,
      placeTags: tags,
    })!;
    const result = await cachedInsights(args, {
      anchors: [],
      filterType: args.filterType,
      location: locationKey(args),
      hop: 1,
      variant: "a",
      exclude: [],
    });
    return result.results.map((hit) => ({ ...hit, tags: tagNames(hit.raw) }));
  };

  const sets = placeTagSets(FANDOM.eventKind);
  console.log(`- do stage counts for ${FANDOM.id} -> ${CITY} (${FANDOM.eventKind}), anchors ${anchorIds.length}`);
  console.log(`  roots do ids removed client-side: ${rootsIds.size}`);
  const outcome = await fillPlaceSlot({
    load: ({ radius, tags }) => loadTags(tags, radius),
    rootsIds,
    fallbackRadius: 40_000,
    tagSets: sets,
  });
  for (const [index, tags] of sets.entries()) {
    console.log(`  set ${index}: ${tags.join(", ")}`);
  }
  console.log(`  first   : ${stagesLabel(outcome.first)}`);
  console.log(`  last    : ${stagesLabel(outcome.attempt)}; retried ${outcome.retried}`);
  console.log(`  tag set used: ${outcome.tagSetIndex} (fallback ${outcome.usedFallback})`);
  console.log(
    `  usable  : ${outcome.cards.length}${outcome.cards.length ? ` (${outcome.cards.map((card) => `${card.name} [${card.tags.slice(0, 3).join(", ")}]`).join(" | ")})` : ""}`,
  );
  return outcome;
}

async function runDo() {
  const seeds = await resolveSeeds([...FANDOM.seeds]);
  for (const seed of seeds) {
    console.log(`seed ${seed.rawText} -> ${seed.name} | ${seed.type} | ${seed.entityId ?? "unresolved"}`);
  }
  const ids = seeds.flatMap((seed) => (seed.entityId ? [seed.entityId] : []));
  const roots = new Map<PackSlot, Hit[]>();
  for (const slot of PACK_SLOTS) {
    roots.set(slot, await load(slot, ids, 0, []));
  }
  for (const slot of PACK_SLOTS) {
    console.log(
      `hop 0 ${slot}: ${(roots.get(slot) ?? []).length} hits; top ${(roots.get(slot) ?? [])[0]?.name ?? "(none)"}`,
    );
  }
  const candidates: AnchorCandidate[] = (["watch", "listen", "wear"] as const).flatMap((slot) =>
    (roots.get(slot) ?? []).slice(0, 1).flatMap((hit, rank) =>
      hit ? [{ id: hit.entityId, name: hit.name, slot, tags: hit.tags, rank }] : [],
    ),
  );
  const anchorIds = anchorsForRule(candidates, await seedTagsOf(FANDOM.seeds.map((seed) => seed.rawText)));
  console.log(`rule B anchors: ${anchorIds.join(", ")}`);
  await doStages(roots, anchorIds);

  const bridge = new Map<PackSlot, Hit[]>();
  for (const slot of PACK_SLOTS) {
    const exclude = (roots.get(slot) ?? []).map((hit) => hit.entityId);
    if (anchorIds.length < 2) {
      bridge.set(slot, []);
      continue;
    }
    bridge.set(slot, await load(slot, anchorIds, 1, exclude));
  }
  console.log("- bridge slots");
  for (const slot of PACK_SLOTS) {
    const hits = bridge.get(slot) ?? [];
    console.log(`  ${slot}: ${hits.length} hits; ${hits.slice(0, 3).map((hit) => hit.name).join(", ") || "(none)"}`);
  }
}

const CANDIDATES = [
  {
    id: "jujutsu-kaisen",
    seeds: [
      { rawText: "Jujutsu Kaisen", type: "urn:entity:tv_show" },
      { rawText: "YOASOBI", type: "urn:entity:artist" },
      { rawText: "Crunchyroll", type: "urn:entity:brand" },
    ],
  },
  {
    id: "studio-ghibli",
    seeds: [
      { rawText: "Studio Ghibli", type: "urn:entity:brand" },
      { rawText: "Joe Hisaishi", type: "urn:entity:artist" },
      { rawText: "Uniqlo", type: "urn:entity:brand" },
    ],
  },
  {
    id: "demon-slayer",
    seeds: [
      { rawText: "Demon Slayer", type: "urn:entity:tv_show" },
      { rawText: "LiSA", type: "urn:entity:artist" },
      { rawText: "Bandai", type: "urn:entity:brand" },
    ],
  },
];

async function runIds() {
  for (const candidate of CANDIDATES) {
    if (process.argv[3] && candidate.id !== process.argv[3]) continue;
    const seeds = await resolveSeeds(candidate.seeds);
    console.log(`=== ${candidate.id}`);
    for (const [index, seed] of seeds.entries()) {
      console.log(
        `  { rawText: "${seed.rawText}", type: "${candidate.seeds[index]!.type}", entityId: "${seed.entityId ?? ""}", resolvedName: "${seed.name}" }  live type ${seed.type}`,
      );
    }
  }
}

/** Bypasses the insight cache: locationKey does not include filter.popularity.min. */
async function runWearMinLive() {
  const seeds = await resolveSeeds([...FANDOM.seeds]);
  const ids = seeds.flatMap((seed) => (seed.entityId ? [seed.entityId] : []));
  const roots = new Map<PackSlot, Hit[]>();
  for (const slot of PACK_SLOTS) roots.set(slot, await load(slot, ids, 0, []));
  const candidates: AnchorCandidate[] = (["watch", "listen", "wear"] as const).flatMap((slot) =>
    (roots.get(slot) ?? []).slice(0, 1).flatMap((hit, rank) =>
      hit ? [{ id: hit.entityId, name: hit.name, slot, tags: hit.tags, rank }] : [],
    ),
  );
  const anchorIds = anchorsForRule(candidates, await seedTagsOf(FANDOM.seeds.map((seed) => seed.rawText)));
  const args = insightArgs({
    slot: "wear",
    eventKind: FANDOM.eventKind,
    anchors: anchorIds,
    city: CITY,
    hop: 1,
    exclude: (roots.get("wear") ?? []).map((hit) => hit.entityId),
    placeTags: [],
  })!;
  const live = await insights({ ...args, filterPopularityMin: 0.05 });
  console.log(`live wear hop 1 with filter.popularity.min=0.05: ${live.results.length}`);
  console.log(`  ${live.results.map((hit) => hit.name).join(", ")}`);
  const cached = await cachedInsights(args, {
    anchors: args.signalInterestsEntities ?? [],
    filterType: args.filterType,
    location: locationKey(args),
    hop: 1,
    variant: "a",
    exclude: args.filterExcludeEntities ?? [],
  });
  console.log(`cached wear hop 1 with min unset: ${cached.results.length}`);
  console.log(`  ${cached.results.map((hit) => hit.name).join(", ")}`);
}

async function runPick() {
  for (const query of ["YOASOBI", "Jujutsu Kaisen", "Crunchyroll"]) {
    const found = await search({ query });
    console.log(`\n"${query}": ${found.results.length}`);
    for (const hit of found.results.slice(0, 5)) {
      console.log(`  ${hit.name} | ${hit.type} | ${hit.entityId}`);
    }
  }
}

async function runWearMin() {
  const seeds = await resolveSeeds([...FANDOM.seeds]);
  const ids = seeds.flatMap((seed) => (seed.entityId ? [seed.entityId] : []));
  const roots = new Map<PackSlot, Hit[]>();
  for (const slot of PACK_SLOTS) roots.set(slot, await load(slot, ids, 0, []));
  const candidates: AnchorCandidate[] = (["watch", "listen", "wear"] as const).flatMap((slot) =>
    (roots.get(slot) ?? []).slice(0, 1).flatMap((hit, rank) =>
      hit ? [{ id: hit.entityId, name: hit.name, slot, tags: hit.tags, rank }] : [],
    ),
  );
  const anchorIds = anchorsForRule(candidates, await seedTagsOf(FANDOM.seeds.map((seed) => seed.rawText)));
  const exclude = (roots.get("wear") ?? []).map((hit) => hit.entityId);
  for (const min of [undefined, 0.05]) {
    const args = insightArgs({
      slot: "wear",
      eventKind: FANDOM.eventKind,
      anchors: anchorIds,
      city: CITY,
      hop: 1,
      exclude,
    })!;
    const merged: InsightsParams = min === undefined ? args : { ...args, filterPopularityMin: min };
    const result = await cachedInsights(merged, {
      anchors: merged.signalInterestsEntities ?? [],
      filterType: merged.filterType,
      location: locationKey(merged),
      hop: 1,
      variant: "a",
      exclude: merged.filterExcludeEntities ?? [],
    });
    console.log(
      `wear hop 1 with filter.popularity.min=${min ?? "(unset)"}: ${result.results.length} -> ${result.results.slice(0, 6).map((hit) => hit.name).join(", ")}`,
    );
  }
}

async function runCandidates() {
  for (const candidate of CANDIDATES) {
    console.log(`\n=== ${candidate.id}`);
    const seeds = await resolveSeeds(candidate.seeds);
    const matched = seeds.filter((seed, index) => seed.type === candidate.seeds[index]!.type).length;
    for (const [index, seed] of seeds.entries()) {
      const expected = candidate.seeds[index]!.type;
      console.log(
        `  ${seed.rawText} -> ${seed.name || "(none)"} | ${seed.type || "(none)"} | ${seed.entityId ?? "(unresolved)"} | ${seed.type === expected ? "type ok" : `EXPECTED ${expected}`}`,
      );
    }
    console.log(`  seeds resolved with the right type: ${matched}/3`);
    const ids = seeds.flatMap((seed) => (seed.entityId ? [seed.entityId] : []));
    if (ids.length < 2) {
      console.log("  hop 0 skipped: fewer than two resolved ids");
      continue;
    }
    for (const slot of ["watch", "listen", "wear"] as const) {
      const hits = await load(slot, ids, 0, []);
      console.log(`  hop 0 ${slot}: ${hits.length}`);
      for (const hit of hits.slice(0, 5)) {
        console.log(`    - ${hit.name} | ${hit.type} | ${hit.tags.slice(0, 5).join(", ")}`);
      }
    }
  }
}

async function runTags() {
  const terms = [
    "arcade",
    "bar",
    "bookstore",
    "comic",
    "hobby",
    "record store",
    "cafe",
    "karaoke",
    "bowling",
    "board game",
    "night market",
    "restaurant",
  ];
  for (const term of terms) {
    const result = await tags({ query: term, parentsTypes: "urn:entity:place" });
    console.log(`\n"${term}": ${result.results.length}`);
    for (const tag of result.results.slice(0, 10)) {
      console.log(`  ${tag.id} | ${tag.name}`);
    }
  }
}

async function main() {
  if (!process.env.QLOO_API_KEY?.trim()) {
    console.log("skipped_no_key");
    process.exit(0);
  }
  enableSmokeGuards(BUDGET);
  const mode = process.argv[2] ?? "do";
  try {
    if (mode === "do") await runDo();
    else if (mode === "candidates") await runCandidates();
    else if (mode === "tags") await runTags();
    else if (mode === "ids") await runIds();
    else if (mode === "wearmin") await runWearMin();
    else if (mode === "pick") await runPick();
    else if (mode === "wearminlive") await runWearMinLive();
    else console.log(`unknown mode ${mode}`);
  } catch (error) {
    console.log(`stopped: ${redact(error instanceof Error ? error.message : String(error))}`);
  }
  console.log(`\nqloo calls this run: ${observedQlooCalls()}; quota ${JSON.stringify(qlooQuota())}`);
  process.exit(0);
}

void main();

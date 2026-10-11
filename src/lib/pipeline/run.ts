import type { EventKind, Prisma, SeedDomain } from "@prisma/client";
import { prisma } from "@/lib/db";
import { qlooApiKey } from "@/lib/qloo/config";
import { search } from "@/lib/qloo/client";
import { cachedInsights, cachedSearch } from "@/lib/qloo/cache";
import { QlooQuotaError, type QlooInsightHit } from "@/lib/qloo/types";
import { assemblePack } from "@/lib/pack/assemble";
import fixture from "@/lib/pack/fixture.json";
import {
  PINNED_PRESETS,
  PLACE_RADIUS_FALLBACK_M,
  PLACE_TIMEOUT_MS,
  PLACE_USE_ANCHORS,
  BRIDGE_VARIANT,
} from "@/lib/pipeline/config";
import { countSharedTags, type AnchorCandidate, type RankedAnchor } from "@/lib/pipeline/anchors";
import {
  chooseBridgeAnchors,
  composeNarratives,
  templateNarrative,
  type AnchorChoice,
  type AnchorSource,
  type LlmCallTrace,
  type LlmFailure,
  type NarrativePlanInput,
  type PlanNarrative,
} from "@/lib/pipeline/llm";
import { geminiCallCount } from "@/lib/llm/gemini-chain";
import { llmStatus, type LlmProviderId } from "@/lib/llm/provider";
import { fillPlaceSlot, placeFallbackNote, placeOmittedNote, type PlaceStages } from "@/lib/pipeline/place";
import {
  insightArgs,
  loadWatchHits,
  locationKey,
  PACK_SLOTS,
  placeTagSets,
  validNamedHit,
  type BridgeRequestVariant,
  type PackSlot,
} from "@/lib/pipeline/requests";
import { runIndependent } from "@/lib/pipeline/settle";
import type { StepId } from "@/lib/i18n/types";

const BUDGET_MS = 40_000;

export type Progress = {
  step: StepId | "error";
  status: "active" | "done" | "skipped" | "error";
  detail?: string;
  packIds?: string[];
  llmMs?: number;
  llmFallback?: string;
  geminiCalls?: number;
};

type ResolvedAnchor = {
  rawText: string;
  entityId: string;
  name: string;
  type: string;
  tags: string[];
  domain: SeedDomain;
};

/** Everything the pack tells the UI about how the LLM was used, per plan. */
type LlmCoverage = {
  provider: LlmProviderId | null;
  off: string | null;
  offReason: string | null;
  anchors: "llm" | "fallback";
  anchorSource: AnchorSource;
  narrative: "llm" | "template";
  headline: string;
  modelUsed: { anchors: string | null; narrative: string | null };
  attempts: { anchors: number; narrative: number };
  chainTried: { anchors: string[]; narrative: string[] };
  latencyMs: { anchors: number; narrative: number };
  calls: number;
  failures: LlmFailure[];
};

type RuleBCoverage = {
  reason?: string;
  anchors: RankedAnchor[];
};

function llmCoverage(input: {
  provider: LlmProviderId | null;
  offReason: string | null;
  anchors: "llm" | "fallback";
  anchorSource: AnchorSource;
  narrative: PlanNarrative;
  failures: LlmFailure[];
  anchorTrace?: LlmCallTrace | null;
  narrativeTrace?: LlmCallTrace | null;
}): LlmCoverage {
  const anchors = input.anchorTrace;
  const narrative = input.narrativeTrace;
  return {
    provider: input.provider,
    off: input.offReason,
    offReason: input.offReason,
    anchors: input.anchors,
    anchorSource: input.anchorSource,
    narrative: input.narrative.source,
    headline: input.narrative.headline,
    modelUsed: { anchors: anchors?.modelUsed ?? null, narrative: narrative?.modelUsed ?? null },
    attempts: { anchors: anchors?.attempts ?? 0, narrative: narrative?.attempts ?? 0 },
    chainTried: { anchors: anchors?.chainTried ?? [], narrative: narrative?.chainTried ?? [] },
    latencyMs: { anchors: anchors?.latencyMs ?? 0, narrative: narrative?.latencyMs ?? 0 },
    calls: (anchors?.calls ?? 0) + (narrative?.calls ?? 0),
    failures: input.failures,
  };
}

type Card = {
  slot: PackSlot;
  entityId: string;
  name: string;
  type: string;
  tags: string[];
  imageUrl: string | null;
  affinity: number | null;
  explainability: string | null;
  chosenByCity?: boolean;
};

function tagNames(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const tags = (raw as { tags?: unknown }).tags;
  if (!Array.isArray(tags)) return [];
  return tags.flatMap((tag) => {
    if (!tag || typeof tag !== "object") return [];
    const name = (tag as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  });
}

/**
 * Seed anchors are pinned to fixed ids, but Bridge ranking still needs the tags that
 * search returns for them, so a pinned seed looks its tags up through the cache.
 */
async function seedTags(rawText: string): Promise<string[]> {
  try {
    const found = await cachedSearch(rawText);
    return tagNames(found.results[0]?.raw);
  } catch (error) {
    if (error instanceof QlooQuotaError) throw error;
    return [];
  }
}

async function seedTagSet(seeds: { rawText: string }[]): Promise<Set<string>> {
  const tags = new Set<string>();
  for (const seed of seeds) {
    for (const tag of await seedTags(seed.rawText)) tags.add(tag.toLowerCase());
  }
  return tags;
}

function perItemScore(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.affinity === "number") return record.affinity;
  if (typeof record.score === "number") return record.score;
  return null;
}

function explainExcerpt(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const query = (raw as { query?: unknown }).query;
  if (!query || typeof query !== "object" || !("explainability" in query)) return null;
  const text = JSON.stringify((query as { explainability?: unknown }).explainability);
  return text ? text.slice(0, 2048) : null;
}

function domainOf(type: string): SeedDomain {
  if (type.endsWith(":artist")) return "artist";
  if (type.endsWith(":movie")) return "movie";
  if (type.endsWith(":tv_show")) return "tv_show";
  if (type.endsWith(":brand")) return "brand";
  if (type.endsWith(":place")) return "place";
  return "unknown";
}

function toCard(slot: PackSlot, hit: QlooInsightHit, excerpt: string | null): Card {
  const tags = tagNames(hit.raw);
  return {
    slot,
    entityId: hit.entityId,
    name: hit.name,
    type: hit.type || slotTypeName(slot),
    tags,
    imageUrl: slot === "do" ? null : hit.imageUrl,
    affinity: perItemScore(hit.raw),
    explainability: excerpt && excerpt.includes(hit.entityId) ? excerpt : null,
  };
}

function slotTypeName(slot: PackSlot): string {
  if (slot === "watch") return "urn:entity:tv_show";
  if (slot === "listen") return "urn:entity:artist";
  if (slot === "wear") return "urn:entity:brand";
  return "urn:entity:place";
}

function pinnedSeeds(texts: string[]) {
  return PINNED_PRESETS.find(
    (preset) =>
      preset.seeds.length === texts.length &&
      preset.seeds.every((seed, index) => seed.rawText === texts[index]),
  );
}

export async function runPipeline(
  sessionId: string,
  emit: (event: Progress) => void,
  signal?: AbortSignal,
  options?: { bridgeVariant?: "a" | "deep"; anchorRule?: "A" | "B" },
): Promise<{ packIds: string[] }> {
  if (!qlooApiKey()) return persistMock(sessionId, emit);
  const started = Date.now();
  const expired = () => Boolean(signal?.aborted) || Date.now() - started > BUDGET_MS;
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { seeds: { orderBy: { id: "asc" } } },
  });
  if (!session) throw new Error("not_found");
  const locale = session.locale === "es" ? "es" : "en";
  const eventKind = session.eventKind ?? "tour";
  const notes = { en: "", es: "" };
  const append = (en: string, es: string) => {
    notes.en = notes.en ? `${notes.en} ${en}` : en;
    notes.es = notes.es ? `${notes.es} ${es}` : es;
  };

  emit({ step: "resolve_seeds", status: "active" });
  const resolved = await resolveSeeds(session.seeds);
  emit({ step: "resolve_seeds", status: "done" });
  if (resolved.length === 0) {
    append("No anchors resolved.", "Ninguna ancla se resolvió.");
    for (const step of ["insights_hop0", "pick_bridge_anchors", "insights_hop1", "assemble", "enrich", "narrate"] as const) {
      emit({ step, status: "skipped" });
    }
    const { provider, offReason } = llmStatus();
    const packIds = await persist(
      sessionId,
      session.city,
      eventKind,
      resolved,
      [],
      {
        provider,
        offReason,
        anchors: "fallback",
        anchorSource: "rule_b_fallback",
        failures: [],
        narratives: {
          A: { label: "A", text: templateNarrative(locale, []), headline: "", source: "template" },
          B: { label: "B", text: templateNarrative(locale, []), headline: "", source: "template" },
        },
      },
      notes,
      locale,
    );
    emit({ step: "done", status: "done", packIds, geminiCalls: geminiCallCount() });
    return { packIds };
  }

  emit({ step: "insights_hop0", status: "active" });
  const rootsLoad = expired()
    ? { slots: emptySlots() }
    : await loadSlots(resolved.map((seed) => seed.entityId), session.city, eventKind, 0, new Map(), "a");
  const roots = rootsLoad.slots;
  if (expired()) append("The pack timed out. What was ready is shown.", "El pack agotó el tiempo. Se muestra lo que alcanzó.");
  emit({ step: "insights_hop0", status: "done" });

  const anchorTags = new Set(resolved.flatMap((seed) => seed.tags.map((tag) => tag.toLowerCase())));
  emit({ step: "pick_bridge_anchors", status: "active" });
  const anchorChoice = expired()
    ? emptyAnchorChoice()
    : await chooseBridgeAnchors(anchorCandidates(roots), anchorTags, options?.anchorRule);
  const anchorIds = anchorChoice.ids;
  const llmFailures: LlmFailure[] = [];
  if (anchorChoice.failure) llmFailures.push(anchorChoice.failure);
  let llmMs = anchorChoice.ms;
  const ruleB: RuleBCoverage = {
    ...(anchorChoice.reason ? { reason: anchorChoice.reason } : {}),
    anchors: anchorChoice.evidence,
  };
  emit({ step: "pick_bridge_anchors", status: "done", detail: anchorIds.join(",") });

  emit({ step: "insights_hop1", status: "active" });
  const excluded = new Map<PackSlot, string[]>();
  for (const slot of PACK_SLOTS) {
    excluded.set(slot, (roots.get(slot) ?? []).map((card) => card.entityId));
  }
  const bridgeLoad =
    expired() || anchorIds.length < 2
      ? { slots: emptySlots() }
      : await loadSlots(
          anchorIds,
          session.city,
          eventKind,
          1,
          excluded,
          options?.bridgeVariant === "deep" ? "deep" : "a",
        );
  const bridge = bridgeLoad.slots;
  notePlaceOmission(bridgeLoad, append);
  emit({ step: "insights_hop1", status: "done" });

  emit({ step: "assemble", status: "active" });
  if ([roots, bridge].some((slots) => (slots.get("do") ?? []).some((card) => card.chosenByCity))) {
    append(
      "Do was chosen for the city, not from the anchors.",
      "Hacer se eligió por la ciudad, no por las anclas.",
    );
  }
  const anchorSlots = anchorsBySlot(anchorChoice.evidence);
  const rootItems = cardsToItems(roots, 0, anchorTags, new Set());
  const rootIds = new Set(rootItems.map((item) => item.entityId));
  const bridgeItems = cardsToItems(bridge, 1, anchorTags, rootIds, anchorSlots);
  const assembled = assemblePack({
    sessionId,
    city: session.city,
    eventKind,
    seeds: resolved.map((seed) => ({ raw: seed.rawText, entityId: seed.entityId, type: seed.type })),
    packs: [
      { label: "A", axis: "root", items: rootItems },
      { label: "B", axis: "bridge", items: bridgeItems },
    ],
    coverage: { notes, mode: options?.bridgeVariant === "deep" ? "deep_cuts" : "default" },
  });
  const planInputs = (["A", "B"] as const).map((label) =>
    narrativePlan(
      label,
      session.city,
      resolved.map((seed) => seed.name),
      assembled.packs.find((pack) => pack.label === label),
    ),
  );
  const templates = new Map(planInputs.map((plan) => [plan.label, templateFor(plan, locale)]));
  const { provider, offReason } = llmStatus();
  // The pack ships with the template narrative so first paint never waits on the LLM.
  const packIds = await persist(
    sessionId,
    session.city,
    eventKind,
    resolved,
    assembled,
    {
      provider,
      offReason,
      anchors: anchorChoice.source,
      anchorSource: anchorChoice.anchorSource,
      failures: llmFailures,
      ruleB,
      anchorTrace: anchorChoice.trace,
      narratives: { A: templates.get("A")!, B: templates.get("B")! },
    },
    assembled.coverage.notes,
    locale,
  );
  emit({ step: "assemble", status: "done" });
  emit({ step: "enrich", status: "skipped" });

  emit({ step: "narrate", status: "active" });
  const narration = signal?.aborted
    ? { plans: [...templates.values()], failures: [] as LlmFailure[], ms: 0, trace: null }
    : await composeNarratives({ locale, plans: planInputs });
  llmMs += narration.ms;
  llmFailures.push(...narration.failures);
  // Write whenever there is something new to record: the LLM text itself, or the
  // failure codes that explain why the template stayed.
  if (narration.plans.some((plan) => plan.source === "llm") || narration.failures.length > 0) {
    await writeNarratives(sessionId, narration.plans, {
      provider,
      offReason,
      anchors: anchorChoice.source,
      anchorSource: anchorChoice.anchorSource,
      failures: llmFailures,
      ruleB,
      anchorTrace: anchorChoice.trace,
      narrativeTrace: narration.trace,
    });
  }
  emit({
    step: "narrate",
    status: "done",
    detail: narration.plans.map((plan) => `${plan.label}:${plan.source}`).join(","),
    ...(narration.failures.length > 0 ? { llmFallback: narration.failures.join(",") } : {}),
  });
  emit({
    step: "done",
    status: "done",
    packIds,
    llmMs,
    geminiCalls: geminiCallCount(),
    ...(llmFailures.length > 0 ? { llmFallback: llmFailures.join(",") } : {}),
  });
  return { packIds };
}

function emptyAnchorChoice(ids: string[] = []): AnchorChoice {
  return {
    ids,
    source: "fallback",
    anchorSource: "rule_b_fallback",
    evidence: [],
    ms: 0,
  };
}

function seedNames(seeds: { resolvedName: string | null }[]): string[] {
  return seeds.flatMap((seed) => (seed.resolvedName?.trim() ? [seed.resolvedName] : []));
}

function templateFor(plan: NarrativePlanInput, locale: "en" | "es"): PlanNarrative {
  const names = Object.values(plan.slots).filter((name): name is string => Boolean(name?.trim()));
  return { label: plan.label, text: templateNarrative(locale, names), headline: "", source: "template" };
}

function emptySlots(): Map<PackSlot, Card[]> {
  return new Map(PACK_SLOTS.map((slot) => [slot, []]));
}

/** States the stage counts and the retry whenever the place slot ends up omitted. */
function notePlaceOmission(load: SlotLoad, append: (en: string, es: string) => void): void {
  if (!load.place) return;
  if (load.place.attempt.afterRoots > 0) {
    const fallback = placeFallbackNote(load.place.tagSetIndex);
    if (fallback) append(fallback.en, fallback.es);
    return;
  }
  const note = placeOmittedNote(load.place.first, load.place.attempt, PLACE_RADIUS_FALLBACK_M, {
    sets: load.place.tagSets,
  });
  append(note.en, note.es);
}

async function resolveSeeds(seeds: { id: string; rawText: string }[]): Promise<ResolvedAnchor[]> {
  const texts = seeds.map((seed) => seed.rawText);
  const preset = pinnedSeeds(texts);
  const resolved: ResolvedAnchor[] = [];
  for (const seed of seeds) {
    const pinned = preset?.seeds.find((item) => item.rawText === seed.rawText);
    if (pinned?.entityId && pinned.resolvedName) {
      const anchor = {
        rawText: seed.rawText,
        entityId: pinned.entityId,
        name: pinned.resolvedName,
        type: pinned.type,
        tags: await seedTags(seed.rawText),
        domain: domainOf(pinned.type),
      };
      resolved.push(anchor);
      await prisma.seed.update({
        where: { id: seed.id },
        data: {
          resolvedEntityId: anchor.entityId,
          resolvedName: anchor.name,
          domain: anchor.domain,
          qlooRaw: { source: "pinned", type: anchor.type },
        },
      });
      continue;
    }
    try {
      const found = await cachedSearch(seed.rawText);
      const top = found.results[0];
      if (!top) continue;
      const anchor = {
        rawText: seed.rawText,
        entityId: top.entityId,
        name: top.name,
        type: top.type,
        tags: tagNames(top.raw),
        domain: domainOf(top.type),
      };
      resolved.push(anchor);
      await prisma.seed.update({
        where: { id: seed.id },
        data: {
          resolvedEntityId: anchor.entityId,
          resolvedName: anchor.name,
          domain: anchor.domain,
          qlooRaw: top.raw as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (error instanceof QlooQuotaError) throw error;
    }
  }
  return resolved;
}

type PlaceReport = {
  first: PlaceStages;
  attempt: PlaceStages;
  retried: boolean;
  tagSets: number;
  tagSetIndex: number;
};

type SlotFetch = { cards: Card[]; place?: PlaceReport };

export type SlotLoad = { slots: Map<PackSlot, Card[]>; place?: PlaceReport };

async function loadSlots(
  anchors: string[],
  city: string,
  eventKind: string,
  hop: 0 | 1,
  excluded: Map<PackSlot, string[]>,
  bridgeVariant: "a" | "deep",
): Promise<SlotLoad> {
  const jobs = PACK_SLOTS.map((slot) => ({
    key: slot,
    run: async () => fetchSlot(slot, anchors, city, eventKind, hop, excluded.get(slot) ?? [], bridgeVariant),
  }));
  const settled = await runIndependent(jobs);
  const slots = new Map<PackSlot, Card[]>();
  let place: PlaceReport | undefined;
  for (const entry of settled) {
    const value = (entry.value ?? { cards: [] }) as SlotFetch;
    slots.set(entry.key as PackSlot, value.cards ?? []);
    if (value.place) place = value.place;
  }
  return { slots, place };
}

async function fetchSlot(
  slot: PackSlot,
  anchors: string[],
  city: string,
  eventKind: string,
  hop: 0 | 1,
  exclude: string[],
  bridgeVariant: "a" | "deep",
): Promise<SlotFetch> {
  const load = async (
    filterType?: "urn:entity:tv_show" | "urn:entity:movie" | "urn:entity:artist" | "urn:entity:brand" | "urn:entity:place",
    placeMode?: "anchors" | "city",
    placeRadius?: number,
    placeTags?: string[],
  ) => {
    const args = insightArgs({
      slot,
      eventKind,
      anchors,
      city,
      hop,
      exclude,
      filterType,
      bridgeVariant: hop === 1 ? bridgeVariant : "a",
      placeMode,
      placeRadius,
      placeTags,
    });
    if (!args) return [] as Card[];
    const variant: BridgeRequestVariant = hop === 1 && bridgeVariant === "deep" ? "deep" : BRIDGE_VARIANT;
    const result = await cachedInsights(
      args,
      {
        anchors: args.signalInterestsEntities ?? [],
        filterType: args.filterType,
        location: locationKey(args),
        hop,
        variant,
        exclude: args.filterExcludeEntities ?? [],
      },
      slot === "do" ? PLACE_TIMEOUT_MS : undefined,
    );
    const excerpt = explainExcerpt(result.raw);
    return result.results.map((hit) => toCard(slot, hit, excerpt));
  };

  if (slot === "watch") {
    return { cards: await loadWatchHits((type) => load(type)) };
  }
  if (slot === "do") {
    const tagSets = placeTagSets(eventKind);
    const outcome = await fillPlaceSlot({
      load: ({ radius, tags }) => load("urn:entity:place", "city", radius, tags),
      rootsIds: new Set(exclude),
      fallbackRadius: PLACE_RADIUS_FALLBACK_M,
      tagSets,
    });
    return {
      cards: outcome.cards.map((card) => ({ ...card, chosenByCity: !PLACE_USE_ANCHORS })),
      place: {
        first: outcome.first,
        attempt: outcome.attempt,
        retried: outcome.retried,
        tagSets: tagSets.length,
        tagSetIndex: outcome.tagSetIndex,
      },
    };
  }
  return { cards: (await load(undefined)).filter(validNamedHit) };
}

function cardsToItems(
  slots: Map<PackSlot, Card[]>,
  hop: 0 | 1,
  anchorTags: Set<string>,
  blocked: Set<string>,
  anchorBySlot?: Map<string, RankedAnchor>,
) {
  const items = [];
  for (const slot of PACK_SLOTS) {
    const cards = slots.get(slot) ?? [];
    const card = cards.find((item) => item.entityId.trim() && item.name.trim() && !blocked.has(item.entityId));
    if (!card) continue;
    const shared = card.tags.filter((tag) => anchorTags.has(tag.toLowerCase())).slice(0, 8);
    const cityChosen = Boolean(card.chosenByCity);
    const anchor = hop === 1 ? anchorBySlot?.get(slot) : undefined;
    const ownConfidence = cityChosen ? "medium" : shared.length > 0 ? "high" : card.tags.length > 0 ? "medium" : "unverified";
    const confidence = anchor?.confidence === "low" ? "low" : ownConfidence;
    items.push({
      slot,
      entityId: card.entityId,
      name: card.name,
      type: card.type,
      hop,
      imageUrl: card.imageUrl,
      affinity: card.affinity,
      explain: { en: card.tags.slice(0, 8).join(", ") || "—", es: card.tags.slice(0, 8).join(", ") || "—" },
      confidence,
      provenance: "qloo" as const,
      evidence: {
        hitTags: card.tags.slice(0, 8),
        sharedTags: shared,
        sharedTagCount: countSharedTags(card.tags, anchorTags),
        ...(card.explainability ? { explainability: card.explainability } : {}),
        ...(cityChosen ? { chosenByCity: true } : {}),
        ...(anchor
          ? {
              anchor: {
                id: anchor.id,
                slot: anchor.slot,
                sharedTags: anchor.sharedTags,
                sharedTagCount: anchor.sharedTagCount,
                confidence: anchor.confidence,
              },
            }
          : {}),
      },
    });
  }
  return items;
}

/** One anchor per slot, exactly the candidates rule B ranks today. */
function anchorCandidates(slots: Map<PackSlot, Card[]>): AnchorCandidate[] {
  return (["watch", "listen", "wear"] as const).flatMap((slot) =>
    (slots.get(slot) ?? []).slice(0, 1).flatMap((hit, rank) =>
      hit ? [{ id: hit.entityId, name: hit.name, slot, tags: hit.tags, rank }] : [],
    ),
  );
}

function anchorsBySlot(evidence: RankedAnchor[]): Map<string, RankedAnchor> {
  return new Map(evidence.map((anchor) => [anchor.slot, anchor]));
}

/** The pack's own names, by slot, so the LLM never has to spell one. */
function narrativePlan(
  label: "A" | "B",
  city: string,
  anchorNames: string[],
  pack: { items: { slot: PackSlot; name: string }[] } | undefined,
): NarrativePlanInput {
  const slots: Partial<Record<"watch" | "listen" | "wear" | "do", string>> = {};
  for (const item of pack?.items ?? []) slots[item.slot] = item.name;
  return {
    label,
    city,
    anchors: anchorNames.map((name) => ({ name })),
    slots,
  };
}

type BridgeMode = "default" | "deep_cuts";

type BridgeSnapshotItem = {
  slot: "watch" | "listen" | "wear" | "do";
  position: number;
  hop: 0 | 1;
  entityId: string;
  name: string;
  type: string;
  imageUrl: string | null;
  affinity: number | null;
  explain: string;
  evidence: Record<string, unknown>;
  confidence: "high" | "medium" | "low" | "unverified";
  provenance: "qloo" | "mock";
};

type PlanCoverage = {
  notes?: { en?: string; es?: string };
  removedFromBridge?: string[];
  mode?: BridgeMode;
  bridgeMode?: BridgeMode;
  defaultBridge?: unknown;
  deepBridge?: unknown;
  ruleB?: unknown;
  llm?: unknown;
};

/** Everything persist and writeNarratives need to describe how the pack was built. */
type PlanCoverageExtras = {
  provider: LlmProviderId | null;
  offReason: string | null;
  anchors: "llm" | "fallback";
  anchorSource: AnchorSource;
  failures: LlmFailure[];
  ruleB?: RuleBCoverage;
  narratives: Partial<Record<"A" | "B", PlanNarrative>>;
  anchorTrace?: LlmCallTrace | null;
  narrativeTrace?: LlmCallTrace | null;
};

type BridgeItem = {
  slot: "watch" | "listen" | "wear" | "do";
  entityId: string;
  name: string;
  type: string;
  hop: 0 | 1;
  imageUrl: string | null;
  affinity: number | null;
  explain: { en: string; es: string };
  confidence: "high" | "medium" | "low" | "unverified";
  provenance: "qloo" | "mock";
  evidence?: Record<string, unknown>;
};

function isBridgeSlot(value: unknown): value is BridgeSnapshotItem["slot"] {
  return value === "watch" || value === "listen" || value === "wear" || value === "do";
}

function readPlanCoverage(value: unknown): PlanCoverage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as PlanCoverage;
}

function readCoverageLlm(value: unknown): { anchors: "llm" | "fallback"; anchorSource: AnchorSource } | null {
  if (!value || typeof value !== "object") return null;
  const anchors = (value as { anchors?: unknown }).anchors;
  const anchorSource = (value as { anchorSource?: unknown }).anchorSource;
  if (anchors !== "llm" && anchors !== "fallback") return null;
  return {
    anchors,
    anchorSource: anchorSource === "llm" || anchorSource === "rule_b_fallback" ? anchorSource : "rule_b_fallback",
  };
}

function readRuleB(value: unknown): RuleBCoverage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const anchors = (value as { anchors?: unknown }).anchors;
  if (!Array.isArray(anchors)) return undefined;
  const reason = (value as { reason?: unknown }).reason;
  return {
    ...(typeof reason === "string" && reason ? { reason } : {}),
    anchors: anchors.filter((anchor): anchor is RankedAnchor => Boolean(anchor && typeof anchor === "object")),
  };
}

function readBridgeSnapshot(value: unknown): BridgeSnapshotItem[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const items: BridgeSnapshotItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const row = entry as Partial<BridgeSnapshotItem>;
    if (!isBridgeSlot(row.slot) || typeof row.entityId !== "string" || !row.entityId.trim()) return null;
    if (typeof row.name !== "string" || !row.name.trim()) return null;
    const confidence =
      row.confidence === "high" || row.confidence === "medium" || row.confidence === "low" || row.confidence === "unverified"
        ? row.confidence
        : "unverified";
    items.push({
      slot: row.slot,
      position: typeof row.position === "number" ? row.position : items.length,
      hop: row.hop === 1 ? 1 : 0,
      entityId: row.entityId,
      name: row.name,
      type: typeof row.type === "string" ? row.type : "",
      imageUrl: typeof row.imageUrl === "string" ? row.imageUrl : null,
      affinity: typeof row.affinity === "number" ? row.affinity : null,
      explain: typeof row.explain === "string" ? row.explain : "—",
      evidence:
        row.evidence && typeof row.evidence === "object" && !Array.isArray(row.evidence)
          ? (row.evidence as Record<string, unknown>)
          : {},
      confidence,
      provenance: row.provenance === "mock" ? "mock" : "qloo",
    });
  }
  return items;
}

function serializeBridgeItems(items: BridgeItem[], locale: "en" | "es"): BridgeSnapshotItem[] {
  return items.map((item, position) => ({
    slot: item.slot,
    position,
    hop: item.hop,
    entityId: item.entityId,
    name: item.name,
    type: item.type,
    imageUrl: item.imageUrl,
    affinity: item.affinity,
    explain: item.explain[locale] || item.explain.en || "—",
    evidence: item.evidence ?? {},
    confidence: item.confidence,
    provenance: item.provenance,
  }));
}

function snapshotToItems(items: BridgeSnapshotItem[]): BridgeItem[] {
  return items.map((item) => ({
    slot: item.slot,
    entityId: item.entityId,
    name: item.name,
    type: item.type,
    hop: item.hop,
    imageUrl: item.imageUrl,
    affinity: item.affinity,
    explain: { en: item.explain || "—", es: item.explain || "—" },
    confidence: item.confidence,
    provenance: item.provenance,
    evidence: item.evidence,
  }));
}

function coverageFor(
  coverage: { notes: { en: string; es: string }; removedFromBridge?: string[]; mode?: BridgeMode },
  label: "A" | "B",
  items: BridgeItem[],
  locale: "en" | "es",
  extras?: PlanCoverageExtras,
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...coverage };
  if (extras) {
    const narrative = extras.narratives[label];
    base.llm = llmCoverage({
      provider: extras.provider,
      offReason: extras.offReason,
      anchors: extras.anchors,
      anchorSource: extras.anchorSource,
      narrative: narrative ?? { label, text: "", headline: "", source: "template" },
      failures: extras.failures,
      anchorTrace: extras.anchorTrace,
      narrativeTrace: extras.narrativeTrace,
    });
  }
  if (label !== "B") return base;
  return {
    ...base,
    bridgeMode: "default",
    defaultBridge: serializeBridgeItems(items, locale),
    ...(extras?.ruleB ? { ruleB: extras.ruleB } : {}),
  };
}

function planCoverage(
  coverage: { notes: { en: string; es: string }; removedFromBridge?: string[]; mode?: BridgeMode },
  label: "A" | "B",
  items: BridgeItem[],
  locale: "en" | "es",
  extras?: PlanCoverageExtras,
): Prisma.InputJsonValue {
  return coverageFor(coverage, label, items, locale, extras) as Prisma.InputJsonValue;
}

function coverageWithSnapshots(
  previous: PlanCoverage,
  coverage: { notes: { en: string; es: string }; removedFromBridge: string[]; mode?: BridgeMode },
  mode: BridgeMode,
  replacement: BridgeSnapshotItem[] | null,
  extras?: PlanCoverageExtras,
): Prisma.InputJsonValue {
  const next: Record<string, unknown> = {
    notes: coverage.notes,
    removedFromBridge: coverage.removedFromBridge,
    mode,
    bridgeMode: mode,
  };
  if (previous.defaultBridge) next.defaultBridge = previous.defaultBridge;
  if (previous.deepBridge) next.deepBridge = previous.deepBridge;
  const narrative = extras?.narratives.B;
  if (extras && narrative) {
    next.llm = llmCoverage({
      provider: extras.provider,
      offReason: extras.offReason,
      anchors: extras.anchors,
      anchorSource: extras.anchorSource,
      narrative,
      failures: extras.failures,
      anchorTrace: extras.anchorTrace,
      narrativeTrace: extras.narrativeTrace,
    });
  } else if (previous.llm) {
    next.llm = previous.llm;
  }
  if (extras?.ruleB) next.ruleB = extras.ruleB;
  else if (previous.ruleB) next.ruleB = previous.ruleB;
  if (replacement) next[mode === "default" ? "defaultBridge" : "deepBridge"] = replacement;
  return next as Prisma.InputJsonValue;
}

/**
 * Rewrites only the narratives the LLM produced. Plan A keeps its stored text when
 * the caller is refining the Bridge, and the pack is already visible either way.
 */
async function writeNarratives(
  sessionId: string,
  narratives: PlanNarrative[],
  extras: Omit<PlanCoverageExtras, "narratives">,
): Promise<void> {
  const rows = await prisma.pack.findMany({ where: { sessionId } });
  for (const narrative of narratives) {
    const row = rows.find((pack) => pack.label === narrative.label);
    if (!row) continue;
    const previous =
      row.coverage && typeof row.coverage === "object" && !Array.isArray(row.coverage)
        ? (row.coverage as Record<string, unknown>)
        : {};
    await prisma.pack.update({
      where: { id: row.id },
      data: {
        narrative: narrative.text,
        coverage: {
          ...previous,
          llm: llmCoverage({ ...extras, narrative }),
        } as Prisma.InputJsonValue,
      },
    });
  }
}

async function writeBridge(
  bridgeId: string,
  narrative: string,
  coverage: Prisma.InputJsonValue,
  items: BridgeItem[],
  locale: "en" | "es",
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.packItem.deleteMany({ where: { packId: bridgeId } });
    await tx.pack.update({
      where: { id: bridgeId },
      data: {
        narrative,
        coverage,
        items: {
          create: items.map((item, position) => ({
            slot: item.slot,
            position,
            hop: item.hop,
            qlooEntityId: item.entityId,
            qlooName: item.name,
            qlooType: item.type,
            imageUrl: item.imageUrl,
            affinityScore: item.affinity,
            explain: item.explain[locale],
            evidence: (item.evidence ?? {}) as Prisma.InputJsonValue,
            confidence: item.confidence,
            provenance: item.provenance,
          })),
        },
      },
    });
  });
}

async function persist(
  sessionId: string,
  city: string,
  eventKind: EventKind | string,
  resolved: ResolvedAnchor[],
  assembled: ReturnType<typeof assemblePack> | [],
  extras: PlanCoverageExtras,
  notes: { en: string; es: string },
  locale: "en" | "es",
): Promise<string[]> {
  const packs = Array.isArray(assembled) ? [] : assembled.packs;
  const coverage = Array.isArray(assembled) ? { notes } : assembled.coverage;
  const ids = await prisma.$transaction(async (tx) => {
    await tx.pack.deleteMany({ where: { sessionId } });
    const created: string[] = [];
    for (const pack of packs) {
      const row = await tx.pack.create({
        data: {
          sessionId,
          label: pack.label,
          axis: pack.axis,
          status: "ready",
          narrative: extras.narratives[pack.label]?.text ?? null,
          coverage: planCoverage(coverage, pack.label, pack.items, locale, extras),
          items: {
            create: pack.items.map((item, position) => ({
              slot: item.slot,
              position,
              hop: item.hop,
              qlooEntityId: item.entityId,
              qlooName: item.name,
              qlooType: item.type,
              imageUrl: item.imageUrl,
              affinityScore: item.affinity,
              explain: item.explain[locale],
              evidence: (item.evidence ?? {}) as Prisma.InputJsonValue,
              confidence: item.confidence,
              provenance: item.provenance,
            })),
          },
        },
      });
      created.push(row.id);
    }
    if (packs.length === 0) {
      for (const label of ["A", "B"] as const) {
        const row = await tx.pack.create({
          data: {
            sessionId,
            label,
            axis: label === "A" ? "root" : "bridge",
            status: "ready",
            coverage: coverageFor({ notes }, label, [], locale, extras) as Prisma.InputJsonValue,
          },
        });
        created.push(row.id);
      }
    }
    await tx.session.update({ where: { id: sessionId }, data: { lastActiveAt: new Date(), city, eventKind: eventKind as EventKind } });
    return created;
  });
  void resolved;
  return ids;
}

async function persistMock(sessionId: string, emit: (event: Progress) => void): Promise<{ packIds: string[] }> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) throw new Error("not_found");
  for (const step of [
    "resolve_seeds",
    "insights_hop0",
    "pick_bridge_anchors",
    "insights_hop1",
    "assemble",
    "enrich",
    "narrate",
  ] as const) {
    emit({ step, status: "done" });
  }
  const assembled = assemblePack({ ...fixture, sessionId });
  const ids = await prisma.$transaction(async (tx) => {
    await tx.pack.deleteMany({ where: { sessionId } });
    const created: string[] = [];
    for (const pack of assembled.packs) {
      const row = await tx.pack.create({
        data: {
          sessionId,
          label: pack.label,
          axis: pack.axis,
          status: "ready",
          narrative: null,
          coverage: planCoverage(assembled.coverage, pack.label, pack.items, "en", {
            provider: null,
            offReason: "mock",
            anchors: "fallback",
            anchorSource: "rule_b_fallback",
            failures: [],
            narratives: {},
          }),
          items: {
            create: pack.items.map((item, position) => ({
              slot: item.slot,
              position,
              hop: item.hop,
              qlooEntityId: item.entityId,
              qlooName: item.name,
              qlooType: item.type,
              imageUrl: item.imageUrl,
              affinityScore: item.affinity,
              explain: item.explain.en,
              evidence: (item.evidence ?? {}) as Prisma.InputJsonValue,
              confidence: item.confidence,
              provenance: "mock",
            })),
          },
        },
      });
      created.push(row.id);
    }
    return created;
  });
  emit({ step: "done", status: "done", packIds: ids, geminiCalls: geminiCallCount() });
  return { packIds: ids };
}

export function packsToWrite(assembled: ReturnType<typeof assemblePack>): {
  label: "B";
  items: ReturnType<typeof assemblePack>["packs"][number]["items"];
} {
  return {
    label: "B",
    items: assembled.packs.find((pack) => pack.label === "B")?.items ?? [],
  };
}

export async function refineBridge(
  sessionId: string,
  mode: "default" | "deep_cuts",
  emit: (event: Progress) => void,
): Promise<{ packIds: string[] }> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      seeds: { orderBy: { id: "asc" } },
      packs: { include: { items: { orderBy: { position: "asc" } } } },
    },
  });
  if (!session) throw new Error("not_found");
  const root = session.packs.find((pack) => pack.label === "A");
  const bridgeRow = session.packs.find((pack) => pack.label === "B");
  if (!root || !bridgeRow) throw new Error("not_found");
  const eventKind = session.eventKind ?? "tour";
  const locale = session.locale === "es" ? "es" : "en";
  const { provider, offReason } = llmStatus();
  const previous = readPlanCoverage(bridgeRow.coverage);
  const storedSnapshot = readBridgeSnapshot(mode === "default" ? previous.defaultBridge : previous.deepBridge);
  if (storedSnapshot) {
    emit({ step: "pick_bridge_anchors", status: "skipped", detail: "snapshot" });
    emit({ step: "insights_hop1", status: "skipped", detail: "snapshot" });
    emit({ step: "assemble", status: "active" });
    const assembled = assemblePack({
      sessionId,
      city: session.city,
      eventKind,
      seeds: session.seeds.flatMap((seed) =>
        seed.resolvedEntityId
          ? [{ raw: seed.rawText, entityId: seed.resolvedEntityId, type: seed.domain }]
          : [],
      ),
      packs: [
        { label: "A", axis: "root", items: storedItems(root.items) },
        { label: "B", axis: "bridge", items: snapshotToItems(storedSnapshot) },
      ],
      coverage: { notes: { en: "", es: "" }, mode },
    });
    const replacement = packsToWrite(assembled);
    const plan = narrativePlan("B", session.city, seedNames(session.seeds), { items: replacement.items });
    const kept = readCoverageLlm(previous.llm);
    const extras: PlanCoverageExtras = {
      provider,
      offReason,
      anchors: kept?.anchors ?? "fallback",
      anchorSource: kept?.anchorSource ?? "rule_b_fallback",
      failures: [],
      ruleB: readRuleB(previous.ruleB),
      narratives: { B: templateFor(plan, locale) },
    };
    // Only the Bridge is rewritten. Plan A keeps its stored narrative and cards.
    await writeBridge(
      bridgeRow.id,
      extras.narratives.B!.text,
      coverageWithSnapshots(previous, assembled.coverage, mode, null, extras),
      replacement.items,
      locale,
    );
    emit({ step: "assemble", status: "done" });
    emit({ step: "enrich", status: "skipped" });
    emit({ step: "narrate", status: "active" });
    const narration = await composeNarratives({ locale, plans: [plan], scope: "bridge" });
    const produced = narration.plans[0]!;
    const failures: LlmFailure[] = [...narration.failures];
    if (produced.source === "llm" || narration.failures.length > 0) {
      await writeBridge(
        bridgeRow.id,
        produced.text,
        coverageWithSnapshots(previous, assembled.coverage, mode, null, {
          ...extras,
          failures,
          narrativeTrace: narration.trace,
          narratives: { B: produced },
        }),
        replacement.items,
        locale,
      );
    }
    emit({
      step: "narrate",
      status: "done",
      detail: `B:${produced.source}`,
      ...(failures.length > 0 ? { llmFallback: failures.join(",") } : {}),
    });
    emit({
      step: "done",
      status: "done",
      packIds: [root.id, bridgeRow.id],
      llmMs: narration.ms,
      geminiCalls: geminiCallCount(),
      ...(failures.length > 0 ? { llmFallback: failures.join(",") } : {}),
    });
    return { packIds: [root.id, bridgeRow.id] };
  }

  const notes = { en: "", es: "" };
  const append = (en: string, es: string) => {
    notes.en = notes.en ? `${notes.en} ${en}` : en;
    notes.es = notes.es ? `${notes.es} ${es}` : es;
  };

  emit({ step: "pick_bridge_anchors", status: "active" });
  const candidates = root.items.flatMap((item) => {
    if (item.slot !== "watch" && item.slot !== "listen" && item.slot !== "wear") return [];
    const shared = storedSharedCount(item.evidence);
    return [
      {
        id: item.qlooEntityId,
        name: item.qlooName,
        slot: item.slot,
        tags: evidenceTags(item.evidence),
        ...(shared === undefined ? {} : { sharedTagCount: shared }),
      },
    ];
  });
  const seedTags = qlooApiKey() ? await seedTagSet(session.seeds) : new Set<string>();
  const anchorChoice = qlooApiKey()
    ? await chooseBridgeAnchors(candidates, seedTags)
    : emptyAnchorChoice(candidates.map((item) => item.id));
  const anchorIds = anchorChoice.ids;
  emit({ step: "pick_bridge_anchors", status: "done", detail: anchorIds.join(",") });

  emit({ step: "insights_hop1", status: "active" });
  const excluded = new Map<PackSlot, string[]>();
  for (const slot of PACK_SLOTS) {
    excluded.set(
      slot,
      root.items.filter((item) => item.slot === slot).map((item) => item.qlooEntityId),
    );
  }
  const bridgeLoad =
    !qlooApiKey() || anchorIds.length < 2
      ? { slots: emptySlots() }
      : await loadSlots(anchorIds, session.city, eventKind, 1, excluded, mode === "deep_cuts" ? "deep" : "a");
  const bridgeSlots = bridgeLoad.slots;
  notePlaceOmission(bridgeLoad, append);
  emit({ step: "insights_hop1", status: "done" });
  if ((bridgeSlots.get("do") ?? []).some((card) => card.chosenByCity)) {
    append(
      "Do was chosen for the city, not from the anchors.",
      "Hacer se eligió por la ciudad, no por las anclas.",
    );
  }

  emit({ step: "assemble", status: "active" });
  const rootIds = new Set(root.items.map((item) => item.qlooEntityId));
  const anchorSlots = anchorsBySlot(anchorChoice.evidence);
  const bridgeItems = qlooApiKey()
    ? cardsToItems(bridgeSlots, 1, seedTags, rootIds, anchorSlots)
    : storedItems(bridgeRow.items);
  const assembled = assemblePack({
    sessionId,
    city: session.city,
    eventKind,
    seeds: session.seeds.flatMap((seed) =>
      seed.resolvedEntityId
        ? [{ raw: seed.rawText, entityId: seed.resolvedEntityId, type: seed.domain }]
        : [],
    ),
    packs: [
      { label: "A", axis: "root", items: storedItems(root.items) },
      { label: "B", axis: "bridge", items: bridgeItems },
    ],
    coverage: { notes, mode },
  });
  const replacement = packsToWrite(assembled);
  const plan = narrativePlan("B", session.city, seedNames(session.seeds), { items: replacement.items });
  const llmFailures: LlmFailure[] = [
    ...(anchorChoice.failure ? [anchorChoice.failure] : []),
  ];
  const extras: PlanCoverageExtras = {
    provider,
    offReason,
    anchors: anchorChoice.source,
    anchorSource: anchorChoice.anchorSource,
    failures: llmFailures,
    ruleB: { ...(anchorChoice.reason ? { reason: anchorChoice.reason } : {}), anchors: anchorChoice.evidence },
    anchorTrace: anchorChoice.trace,
    narratives: { B: templateFor(plan, locale) },
  };
  // Persist the template first so the Bridge is never blocked on the LLM.
  await writeBridge(
    bridgeRow.id,
    extras.narratives.B!.text,
    coverageWithSnapshots(previous, assembled.coverage, mode, serializeBridgeItems(replacement.items, locale), extras),
    replacement.items,
    locale,
  );
  emit({ step: "assemble", status: "done" });
  emit({ step: "enrich", status: "skipped" });
  emit({ step: "narrate", status: "active" });
  const narration = await composeNarratives({ locale, plans: [plan], scope: "bridge" });
  const produced = narration.plans[0]!;
  llmFailures.push(...narration.failures);
  if (produced.source === "llm") {
    await writeBridge(
      bridgeRow.id,
      produced.text,
        coverageWithSnapshots(previous, assembled.coverage, mode, serializeBridgeItems(replacement.items, locale), {
        ...extras,
        failures: llmFailures,
        narrativeTrace: narration.trace,
        narratives: { B: produced },
      }),
      replacement.items,
      locale,
    );
  }
  emit({
    step: "narrate",
    status: "done",
    detail: `B:${produced.source}`,
    ...(narration.failures.length > 0 ? { llmFallback: narration.failures.join(",") } : {}),
  });
  emit({
    step: "done",
    status: "done",
    packIds: [root.id, bridgeRow.id],
    llmMs: anchorChoice.ms + narration.ms,
    geminiCalls: geminiCallCount(),
    ...(llmFailures.length > 0 ? { llmFallback: llmFailures.join(",") } : {}),
  });
  return { packIds: [root.id, bridgeRow.id] };
}

function storedSharedCount(evidence: unknown): number | undefined {
  if (!evidence || typeof evidence !== "object") return undefined;
  const value = (evidence as { sharedTagCount?: unknown }).sharedTagCount;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function evidenceTags(evidence: unknown): string[] {
  if (!evidence || typeof evidence !== "object") return [];
  const tags = (evidence as { hitTags?: unknown }).hitTags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}

function storedItems(
  items: {
    slot: string;
    hop: number;
    qlooEntityId: string;
    qlooName: string;
    qlooType: string;
    imageUrl: string | null;
    affinityScore: number | null;
    explain: string | null;
    evidence: unknown;
    confidence: string;
    provenance: string;
  }[],
) {
  return items.flatMap((item) => {
    if (item.slot !== "watch" && item.slot !== "listen" && item.slot !== "wear" && item.slot !== "do") return [];
    const confidence =
      item.confidence === "high" || item.confidence === "medium" || item.confidence === "low" || item.confidence === "unverified"
        ? item.confidence
        : "unverified";
    return [
      {
        slot: item.slot,
        entityId: item.qlooEntityId,
        name: item.qlooName,
        type: item.qlooType,
        hop: item.hop === 1 ? (1 as const) : (0 as const),
        imageUrl: item.imageUrl,
        affinity: item.affinityScore,
        explain: { en: item.explain || "—", es: item.explain || "—" },
        confidence,
        provenance: item.provenance === "mock" ? ("mock" as const) : ("qloo" as const),
        evidence: evidenceRecord(item.evidence),
      },
    ];
  });
}

function evidenceRecord(evidence: unknown): Record<string, unknown> | undefined {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return undefined;
  return evidence as Record<string, unknown>;
}

export async function resolveOnly(
  sessionId: string,
): Promise<{ rawText: string; resolvedName: string; type: string; entityId: string }[]> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { seeds: { orderBy: { id: "asc" } } },
  });
  if (!session) throw new Error("not_found");
  if (!qlooApiKey()) {
    const resolved = [];
    for (const seed of session.seeds) {
      const found = await search({ query: seed.rawText });
      const top = found.results[0];
      if (!top) continue;
      resolved.push({
        rawText: seed.rawText,
        resolvedName: top.name,
        type: top.type,
        entityId: top.entityId,
      });
    }
    return resolved;
  }
  const resolved = await resolveSeeds(session.seeds);
  return resolved.map((seed) => ({
    rawText: seed.rawText,
    resolvedName: seed.name,
    type: seed.type,
    entityId: seed.entityId,
  }));
}

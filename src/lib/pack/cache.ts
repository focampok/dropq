import { createHash } from "node:crypto";
import type { EventKind, Prisma, SeedDomain, SeedSource } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  PACK_CACHE_PRESET_TTL_HOURS,
  PACK_CACHE_TTL_HOURS,
} from "@/lib/config";
import { isPresetSession } from "@/lib/abuse";
import { PIPELINE_VERSION } from "@/lib/pipeline/config";

export type PackCacheMode = "default" | "deep_cuts";

export type CachedPackItem = {
  slot: "watch" | "listen" | "wear" | "do";
  position: number;
  hop: number;
  qlooEntityId: string;
  qlooName: string;
  qlooType: string;
  imageUrl: string | null;
  affinityScore: number | null;
  explain: string | null;
  evidence: Prisma.JsonValue;
  confidence: "high" | "medium" | "low" | "unverified";
  provenance: "qloo" | "mock";
};

export type CachedPack = {
  label: "A" | "B";
  axis: "root" | "bridge";
  narrative: string | null;
  coverage: Prisma.JsonValue;
  items: CachedPackItem[];
};

export type PackCachePayload = {
  city: string;
  eventKind: EventKind;
  locale: string;
  seeds: {
    rawText: string;
    source: SeedSource;
    resolvedEntityId: string | null;
    resolvedName: string | null;
    domain: SeedDomain;
  }[];
  packs: CachedPack[];
};

type Flight = {
  promise: Promise<{ payload: PackCachePayload; builtAt: Date }>;
  ownerSessionId: string;
};

const inflight = new Map<string, Flight>();

export function packSignature(input: {
  entityIds: string[];
  city: string;
  eventKind: string;
  locale: string;
  mode?: PackCacheMode;
  /** Overridden only by tests; production always signs with the current pipeline. */
  pipelineVersion?: string;
}): string {
  const normalized = {
    pipeline: input.pipelineVersion ?? PIPELINE_VERSION,
    entityIds: [...input.entityIds].map((id) => id.trim().toUpperCase()).filter(Boolean).sort(),
    city: input.city.trim().toLowerCase(),
    eventKind: input.eventKind,
    locale: input.locale === "es" ? "es" : "en",
    mode: input.mode ?? "default",
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function ttlMs(isPreset: boolean): number {
  return (isPreset ? PACK_CACHE_PRESET_TTL_HOURS : PACK_CACHE_TTL_HOURS) * 60 * 60_000;
}

/** True when `builtAt` is older than the configured TTL for that row kind. */
export function packCacheExpired(builtAt: Date, isPreset: boolean, nowMs = Date.now()): boolean {
  return nowMs - builtAt.getTime() > ttlMs(isPreset);
}

/**
 * Look up a cached pack by signature.
 * - Missing row → null (caller may live-build).
 * - Ordinary pack past TTL → null (hard miss).
 * - Preset row → always served when present, even past TTL (age shown via cache note).
 */
export async function readPackCache(
  signature: string,
): Promise<{ payload: PackCachePayload; builtAt: Date; isPreset: boolean } | null> {
  const row = await prisma.packCache.findUnique({ where: { signature } });
  if (!row) return null;
  if (!row.isPreset && packCacheExpired(row.builtAt, false)) return null;
  return {
    payload: row.payload as unknown as PackCachePayload,
    builtAt: row.builtAt,
    isPreset: row.isPreset,
  };
}

export type NarrationGrade = "llm" | "template";

/** `llm` only when every plan recorded an LLM narrative; otherwise `template`. */
export function packNarrationGrade(payload: PackCachePayload): NarrationGrade {
  const packs = payload.packs ?? [];
  if (packs.length === 0) return "template";
  return packs.every((pack) => {
    const coverage = pack.coverage;
    if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) return false;
    const llm = (coverage as { llm?: { narrative?: unknown } }).llm;
    return llm?.narrative === "llm";
  })
    ? "llm"
    : "template";
}

/** True when `candidate` is equal or better than `existing` (`llm` beats `template`). */
export function narrationGradeReplaces(candidate: NarrationGrade, existing: NarrationGrade): boolean {
  if (candidate === "llm") return true;
  return existing === "template";
}

/** Stamp `coverage.cache.narration` on every plan for warm / check readers. */
export function stampCacheNarration(payload: PackCachePayload, grade: NarrationGrade): PackCachePayload {
  return {
    ...payload,
    packs: payload.packs.map((pack) => {
      const coverage =
        pack.coverage && typeof pack.coverage === "object" && !Array.isArray(pack.coverage)
          ? { ...(pack.coverage as Record<string, unknown>) }
          : {};
      const prevCache =
        coverage.cache && typeof coverage.cache === "object" && !Array.isArray(coverage.cache)
          ? { ...(coverage.cache as Record<string, unknown>) }
          : {};
      return {
        ...pack,
        coverage: { ...coverage, cache: { ...prevCache, narration: grade } } as Prisma.JsonValue,
      };
    }),
  };
}

export async function writePackCache(input: {
  signature: string;
  payload: PackCachePayload;
  qlooCalls: number;
  isPreset: boolean;
}): Promise<Date> {
  const builtAt = new Date();
  await prisma.packCache.upsert({
    where: { signature: input.signature },
    create: {
      signature: input.signature,
      payload: input.payload as unknown as Prisma.InputJsonValue,
      builtAt,
      qlooCalls: input.qlooCalls,
      isPreset: input.isPreset,
    },
    update: {
      payload: input.payload as unknown as Prisma.InputJsonValue,
      builtAt,
      qlooCalls: input.qlooCalls,
      isPreset: input.isPreset,
    },
  });
  return builtAt;
}

/**
 * Never replace an LLM-narrated preset with a template one. Equal grade → newer wins.
 * Returns whether the row was written.
 */
export async function writePackCacheIfBetter(input: {
  signature: string;
  payload: PackCachePayload;
  qlooCalls: number;
  isPreset: boolean;
}): Promise<{ wrote: boolean; builtAt: Date; grade: NarrationGrade }> {
  const grade = packNarrationGrade(input.payload);
  const stamped = stampCacheNarration(input.payload, grade);
  const existing = await prisma.packCache.findUnique({ where: { signature: input.signature } });
  if (existing) {
    const existingGrade = packNarrationGrade(existing.payload as unknown as PackCachePayload);
    if (!narrationGradeReplaces(grade, existingGrade)) {
      return { wrote: false, builtAt: existing.builtAt, grade: existingGrade };
    }
  }
  const builtAt = await writePackCache({ ...input, payload: stamped });
  return { wrote: true, builtAt, grade };
}

/**
 * Single-flight around a live build. The owner runs `build`; waiters share the promise
 * and then materialize into their own session.
 */
export function beginPackFlight(
  signature: string,
  ownerSessionId: string,
  build: () => Promise<{ payload: PackCachePayload; builtAt: Date }>,
): { owner: boolean; promise: Promise<{ payload: PackCachePayload; builtAt: Date }> } {
  const existing = inflight.get(signature);
  if (existing) return { owner: false, promise: existing.promise };
  const promise = build().finally(() => {
    inflight.delete(signature);
  });
  inflight.set(signature, { promise, ownerSessionId });
  return { owner: true, promise };
}

export function resetPackSingleFlight(): void {
  inflight.clear();
}

function withCacheCoverage(coverage: Prisma.JsonValue, builtAt: Date): Prisma.InputJsonValue {
  const base =
    coverage && typeof coverage === "object" && !Array.isArray(coverage)
      ? { ...(coverage as Record<string, unknown>) }
      : {};
  return {
    ...base,
    cache: { hit: true, builtAt: builtAt.toISOString() },
  } as Prisma.InputJsonValue;
}

/**
 * Copy a cached pack into this session. The cache row is never mutated.
 * Session isolation (403 across cookies) still holds because packs are per-session.
 */
export async function materializeCachedPack(
  sessionId: string,
  cached: { payload: PackCachePayload; builtAt: Date },
): Promise<string[]> {
  const { payload, builtAt } = cached;
  return prisma.$transaction(async (tx) => {
    await tx.seed.deleteMany({ where: { sessionId } });
    for (const seed of payload.seeds) {
      await tx.seed.create({
        data: {
          sessionId,
          rawText: seed.rawText,
          source: seed.source,
          resolvedEntityId: seed.resolvedEntityId,
          resolvedName: seed.resolvedName,
          domain: seed.domain,
        },
      });
    }
    await tx.pack.deleteMany({ where: { sessionId } });
    const ids: string[] = [];
    for (const pack of payload.packs) {
      const row = await tx.pack.create({
        data: {
          sessionId,
          label: pack.label,
          axis: pack.axis,
          status: "ready",
          narrative: pack.narrative,
          coverage: withCacheCoverage(pack.coverage, builtAt),
          items: {
            create: pack.items.map((item) => ({
              slot: item.slot,
              position: item.position,
              hop: item.hop,
              qlooEntityId: item.qlooEntityId,
              qlooName: item.qlooName,
              qlooType: item.qlooType,
              imageUrl: item.imageUrl,
              affinityScore: item.affinityScore,
              explain: item.explain,
              evidence: (item.evidence ?? {}) as Prisma.InputJsonValue,
              confidence: item.confidence,
              provenance: item.provenance,
            })),
          },
        },
      });
      ids.push(row.id);
    }
    await tx.session.update({
      where: { id: sessionId },
      data: {
        city: payload.city,
        eventKind: payload.eventKind,
        locale: payload.locale,
        lastActiveAt: new Date(),
      },
    });
    return ids;
  });
}

export async function snapshotSessionPacks(sessionId: string): Promise<PackCachePayload | null> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      seeds: { orderBy: { id: "asc" } },
      packs: { include: { items: { orderBy: { position: "asc" } } }, orderBy: { label: "asc" } },
    },
  });
  if (!session || session.packs.length === 0) return null;
  return {
    city: session.city,
    eventKind: session.eventKind ?? "tour",
    locale: session.locale,
    seeds: session.seeds.map((seed) => ({
      rawText: seed.rawText,
      source: seed.source,
      resolvedEntityId: seed.resolvedEntityId,
      resolvedName: seed.resolvedName,
      domain: seed.domain,
    })),
    packs: session.packs.map((pack) => ({
      label: pack.label as "A" | "B",
      axis: pack.axis as "root" | "bridge",
      narrative: pack.narrative,
      // Strip transient cache marker so the stored row stays a pure build snapshot.
      coverage: stripCacheMarker(pack.coverage),
      items: pack.items.map((item) => ({
        slot: item.slot as CachedPackItem["slot"],
        position: item.position,
        hop: item.hop,
        qlooEntityId: item.qlooEntityId,
        qlooName: item.qlooName,
        qlooType: item.qlooType,
        imageUrl: item.imageUrl,
        affinityScore: item.affinityScore,
        explain: item.explain,
        evidence: item.evidence as Prisma.JsonValue,
        confidence: item.confidence as CachedPackItem["confidence"],
        provenance: item.provenance as CachedPackItem["provenance"],
      })),
    })),
  };
}

function stripCacheMarker(coverage: Prisma.JsonValue): Prisma.JsonValue {
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) return coverage;
  const rest = { ...(coverage as Record<string, unknown>) };
  delete rest.cache;
  return rest as Prisma.JsonValue;
}

export function cachedStreamEvents(
  packIds: string[],
): { step: string; status: string; detail?: string; packIds?: string[]; cached?: boolean; geminiCalls?: number }[] {
  const steps = [
    "resolve_seeds",
    "insights_hop0",
    "pick_bridge_anchors",
    "insights_hop1",
    "assemble",
    "enrich",
    "narrate",
    "done",
  ] as const;
  return steps.map((step) =>
    step === "done"
      ? { step, status: "done", packIds, cached: true, geminiCalls: 0 }
      : { step, status: "done", cached: true },
  );
}

export function detectPresetFromPayload(payload: PackCachePayload): boolean {
  return isPresetSession(payload.seeds);
}

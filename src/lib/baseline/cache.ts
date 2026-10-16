import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  PACK_CACHE_PRESET_TTL_HOURS,
  PACK_CACHE_TTL_HOURS,
} from "@/lib/config";
import type { BaselinePayload, BaselineSource } from "@/lib/baseline/types";
import { validateBaseline } from "@/lib/baseline/validate";

type Flight = {
  promise: Promise<{ payload: BaselinePayload; builtAt: Date }>;
};

const inflight = new Map<string, Flight>();

function ttlMs(isPreset: boolean): number {
  return (isPreset ? PACK_CACHE_PRESET_TTL_HOURS : PACK_CACHE_TTL_HOURS) * 60 * 60_000;
}

export function baselineExpired(builtAt: Date, isPreset: boolean, nowMs = Date.now()): boolean {
  return nowMs - builtAt.getTime() > ttlMs(isPreset);
}

export async function readBaselineCache(
  signature: string,
): Promise<{ payload: BaselinePayload; builtAt: Date; isPreset: boolean } | null> {
  const row = await prisma.baselineRun.findUnique({ where: { signature } });
  if (!row) return null;
  if (!row.isPreset && baselineExpired(row.builtAt, false)) return null;
  return {
    payload: rowToPayload(row),
    builtAt: row.builtAt,
    isPreset: row.isPreset,
  };
}

function rowToPayload(row: {
  cardsSig: string;
  locale: string;
  llmItems: Prisma.JsonValue;
  verification: Prisma.JsonValue;
  source: string;
}): BaselinePayload {
  const llmItems = row.llmItems as BaselinePayload["llmItems"];
  const verification = row.verification as BaselinePayload["verification"];
  return {
    cardsSig: row.cardsSig,
    locale: row.locale === "es" ? "es" : "en",
    llmItems,
    verification,
    source: row.source === "llm" ? "llm" : "template",
    summary: {
      verified: verification.filter((entry) => entry.status === "verified").length,
      inPack: verification.filter((entry) => entry.inPack).length,
    },
  };
}

/** Never replace an llm baseline with a template one. Malformed payloads are not written. */
export async function writeBaselineIfBetter(input: {
  signature: string;
  cardsSig: string;
  locale: "en" | "es";
  payload: BaselinePayload;
  qlooCalls: number;
  isPreset: boolean;
}): Promise<{ wrote: boolean; builtAt: Date; source: BaselineSource; invalidRule?: string }> {
  const validation = validateBaseline(input.payload);
  if (!validation.ok) {
    const existing = await prisma.baselineRun.findUnique({ where: { signature: input.signature } });
    return {
      wrote: false,
      builtAt: existing?.builtAt ?? new Date(0),
      source: (existing?.source as BaselineSource) ?? input.payload.source,
      invalidRule: validation.rule,
    };
  }
  const existing = await prisma.baselineRun.findUnique({ where: { signature: input.signature } });
  if (existing?.source === "llm" && input.payload.source !== "llm") {
    return { wrote: false, builtAt: existing.builtAt, source: "llm" };
  }
  const builtAt = new Date();
  await prisma.baselineRun.upsert({
    where: { signature: input.signature },
    create: {
      signature: input.signature,
      cardsSig: input.cardsSig,
      locale: input.locale,
      llmItems: input.payload.llmItems as unknown as Prisma.InputJsonValue,
      verification: input.payload.verification as unknown as Prisma.InputJsonValue,
      source: input.payload.source,
      builtAt,
      isPreset: input.isPreset,
      qlooCalls: input.qlooCalls,
    },
    update: {
      llmItems: input.payload.llmItems as unknown as Prisma.InputJsonValue,
      verification: input.payload.verification as unknown as Prisma.InputJsonValue,
      source: input.payload.source,
      builtAt,
      isPreset: input.isPreset,
      qlooCalls: input.qlooCalls,
    },
  });
  return { wrote: true, builtAt, source: input.payload.source };
}

export function beginBaselineFlight(
  signature: string,
  build: () => Promise<{ payload: BaselinePayload; builtAt: Date }>,
): { owner: boolean; promise: Promise<{ payload: BaselinePayload; builtAt: Date }> } {
  const existing = inflight.get(signature);
  if (existing) return { owner: false, promise: existing.promise };
  const promise = build().finally(() => {
    inflight.delete(signature);
  });
  inflight.set(signature, { promise });
  return { owner: true, promise };
}

export function resetBaselineSingleFlight(): void {
  inflight.clear();
}

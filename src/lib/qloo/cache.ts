import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { insights, qlooQuota, search } from "@/lib/qloo/client";
import type { InsightsParams, QlooEntity, QlooInsightHit, QlooResult } from "@/lib/qloo/types";
import { QlooQuotaError } from "@/lib/qloo/types";

const ENTITY_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const INSIGHT_TTL_MS = 72 * 60 * 60 * 1000;

export type InsightCacheParts = {
  anchors: string[];
  filterType: string;
  location: string;
  hop: 0 | 1;
  variant: string;
  exclude: string[];
};

export function insightCacheKey(parts: InsightCacheParts): string {
  const payload = JSON.stringify({
    anchors: [...parts.anchors].sort(),
    filterType: parts.filterType,
    location: parts.location,
    hop: parts.hop,
    variant: parts.hop === 1 ? parts.variant : "",
    exclude: [...parts.exclude].sort(),
  });
  return createHash("sha256").update(payload).digest("hex");
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function rankOf(metadata: unknown): number {
  if (!metadata || typeof metadata !== "object") return 0;
  const rank = (metadata as { rank?: unknown }).rank;
  return typeof rank === "number" ? rank : 0;
}

function entityFromRow(row: { entityId: string; type: string; name: string; metadata: unknown }): QlooEntity {
  const metadata = row.metadata && typeof row.metadata === "object" ? (row.metadata as { raw?: unknown }) : {};
  return {
    entityId: row.entityId,
    name: row.name,
    type: row.type,
    imageUrl: null,
    raw: metadata.raw ?? row.metadata,
  };
}

export async function cachedSearch(query: string, type?: string): Promise<QlooResult<QlooEntity[]>> {
  const normalized = query.trim().toLowerCase();
  const cutoff = new Date(Date.now() - ENTITY_TTL_MS);
  const rows = await prisma.qlooEntityCache.findMany({
    where: {
      fetchedAt: { gte: cutoff },
      AND: [
        { metadata: { path: ["query"], equals: normalized } },
        { metadata: { path: ["queryType"], equals: type ?? "" } },
      ],
    },
  });
  if (rows.length > 0) {
    const ordered = [...rows].sort((left, right) => rankOf(left.metadata) - rankOf(right.metadata));
    return { provenance: "qloo", results: ordered.map(entityFromRow) };
  }
  if (qlooQuota().blocked) throw new QlooQuotaError();
  const fresh = await search({ query, type });
  for (const [index, entity] of fresh.results.entries()) {
    await prisma.qlooEntityCache.upsert({
      where: { entityId: entity.entityId },
      create: {
        entityId: entity.entityId,
        type: entity.type,
        name: entity.name,
        metadata: asJson({ query: normalized, queryType: type ?? "", rank: index, raw: entity.raw }),
        fetchedAt: new Date(),
      },
      update: {
        type: entity.type,
        name: entity.name,
        metadata: asJson({ query: normalized, queryType: type ?? "", rank: index, raw: entity.raw }),
        fetchedAt: new Date(),
      },
    });
  }
  return fresh;
}

export async function cachedInsights(
  args: InsightsParams,
  parts: InsightCacheParts,
  timeoutMs?: number,
): Promise<QlooResult<QlooInsightHit[]>> {
  const cacheKey = insightCacheKey(parts);
  const cutoff = new Date(Date.now() - INSIGHT_TTL_MS);
  const cached = await prisma.insightCache.findUnique({ where: { cacheKey } });
  if (cached && cached.fetchedAt >= cutoff && cached.response && typeof cached.response === "object") {
    const stored = cached.response as { hits?: QlooInsightHit[]; raw?: unknown };
    return { provenance: "qloo", results: stored.hits ?? [], raw: stored.raw };
  }
  if (qlooQuota().blocked) throw new QlooQuotaError();
  const fresh = await insights(args, timeoutMs);
  await prisma.insightCache.upsert({
    where: { cacheKey },
    create: {
      cacheKey,
      filterType: args.filterType,
      response: asJson({ hits: fresh.results, raw: fresh.raw ?? null }),
      fetchedAt: new Date(),
    },
    update: {
      filterType: args.filterType,
      response: asJson({ hits: fresh.results, raw: fresh.raw ?? null }),
      fetchedAt: new Date(),
    },
  });
  return fresh;
}

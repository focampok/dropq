/**
 * Local-profile only: read the app's own recorded Qloo build count from `PackCache`.
 * No API exposes a live Qloo counter, so this is the authoritative number for live builds;
 * bridge refinements are charged separately as a documented estimate.
 */
import { PrismaClient } from "@prisma/client";

let client: PrismaClient | null = null;

function prisma(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}

export async function qlooBuildsSince(sinceMs: number): Promise<number> {
  const rows = await prisma().packCache.findMany({
    where: { builtAt: { gte: new Date(sinceMs) } },
    select: { qlooCalls: true },
  });
  return rows.reduce((sum, row) => sum + (row.qlooCalls ?? 0), 0);
}

/**
 * Make the run repeatable: drop every pack-cache row except the six warmed preset rows,
 * so the custom live scenarios are genuinely live instead of a hit from the previous run.
 */
export async function clearNonWarmCache(keep: string[]): Promise<number> {
  const cleared = await prisma().packCache.deleteMany({ where: { signature: { notIn: keep } } });
  return cleared.count;
}

export async function deletePackCache(signature: string): Promise<number> {
  const result = await prisma().packCache.deleteMany({ where: { signature } });
  return result.count;
}

export async function disconnect(): Promise<void> {
  await client?.$disconnect();
  client = null;
}

/** Local-only fixture: a custom (non-preset) session with two packs, no Qloo spend. */
export async function createCustomBriefFixture(): Promise<{
  sessionId: string;
  packId: string;
  cookieValue: string;
}> {
  const { sealSessionId } = await import("../../src/lib/session/cookie");
  const db = prisma();
  const session = await db.session.create({
    data: {
      locale: "en",
      city: "Houston",
      eventKind: "tour",
      seeds: {
        create: [
          {
            rawText: "UniqueAnchorAlpha",
            source: "text",
            domain: "artist",
            resolvedName: "UniqueAnchorAlpha",
            resolvedEntityId: "custom-a",
          },
          {
            rawText: "UniqueAnchorBeta",
            source: "text",
            domain: "brand",
            resolvedName: "UniqueAnchorBeta",
            resolvedEntityId: "custom-b",
          },
          {
            rawText: "UniqueAnchorGamma",
            source: "text",
            domain: "artist",
            resolvedName: "UniqueAnchorGamma",
            resolvedEntityId: "custom-c",
          },
        ],
      },
      packs: {
        create: [
          {
            label: "A",
            axis: "root",
            status: "ready",
            narrative: "Custom roots.",
            coverage: { notes: { en: "", es: "" }, llm: { narrative: "template", anchors: "fallback" } },
            items: {
              create: (["watch", "listen", "wear", "do"] as const).map((slot, position) => ({
                slot,
                position,
                hop: 0,
                qlooEntityId: `custom-${slot}-a`,
                qlooName: `Custom ${slot} A`,
                qlooType: "urn:entity:artist",
                explain: "Custom explain",
                confidence: "medium",
                provenance: "qloo",
                evidence: { sharedTags: ["Custom"] },
              })),
            },
          },
          {
            label: "B",
            axis: "bridge",
            status: "ready",
            narrative: "Custom bridge.",
            coverage: { notes: { en: "", es: "" }, llm: { narrative: "template", anchors: "fallback" } },
            items: {
              create: (["watch", "listen", "wear", "do"] as const).map((slot, position) => ({
                slot,
                position,
                hop: 1,
                qlooEntityId: `custom-${slot}-b`,
                qlooName: `Custom ${slot} B`,
                qlooType: "urn:entity:artist",
                explain: "Custom explain",
                confidence: "medium",
                provenance: "qloo",
                evidence: { sharedTags: ["Custom"] },
              })),
            },
          },
        ],
      },
    },
    include: { packs: true },
  });
  const packId = session.packs.find((pack) => pack.label === "A")?.id ?? session.packs[0]!.id;
  const cookieValue = await sealSessionId(session.id);
  return { sessionId: session.id, packId, cookieValue };
}

export async function deleteSessionCascade(sessionId: string): Promise<void> {
  await prisma().session.delete({ where: { id: sessionId } }).catch(() => undefined);
}

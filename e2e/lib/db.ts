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

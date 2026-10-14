import { PrismaClient } from "@prisma/client";

/**
 * Pool cap for a small single-instance Postgres. Prisma's own default is
 * `num_cpus * 2 + 1`, which on a small container times a few route bundles can
 * exhaust the server's connection slots. 5 is plenty for this workload (the
 * health probe plus one pack build at a time) and keeps headroom for the
 * migration step. Set here rather than in the connection string so the
 * deployed `DATABASE_URL` needs no editing.
 */
const CONNECTION_LIMIT = 5;

/** Add the pool cap unless the operator already chose one. Never throws. */
function withConnectionLimit(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.searchParams.has("connection_limit")) {
      url.searchParams.set("connection_limit", String(CONNECTION_LIMIT));
    }
    return url.toString();
  } catch {
    // Unparseable URL: hand it to Prisma untouched so the failure is its own.
    return raw;
  }
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL?.trim();
  // Without a URL (for example during `next build`) construct with no override;
  // Prisma only needs the datasource when a query actually runs.
  return url ? new PrismaClient({ datasourceUrl: withConnectionLimit(url) }) : new PrismaClient();
}

export const prisma = globalForPrisma.prisma ?? createClient();

// Cache on globalThis in every environment, not just development. Next.js
// evaluates route bundles separately, so an uncached module hands each chunk its
// own client and multiplies the pool by the number of routes that touch the DB.
globalForPrisma.prisma = prisma;

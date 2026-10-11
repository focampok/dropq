import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkBootEnv } from "@/lib/env-check";
import { enforceRateLimit } from "@/lib/rate-limit";

/** Public health: ok + db only. No versions, env names, quota or call counts. */
export async function GET(request: Request) {
  checkBootEnv();
  const limited = enforceRateLimit(request, "other");
  if (limited) return limited;

  let db: "up" | "down" = "up";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    db = "down";
  }

  return NextResponse.json(
    { ok: db === "up", db },
    { headers: { "Cache-Control": "no-store" } },
  );
}

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { jsonError, readJson } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requireSession } from "@/lib/session/require";
import { seedsSchema } from "@/lib/session/schema";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const limited = enforceRateLimit(request, "other");
  if (limited) return limited;
  const { id } = await context.params;
  const gate = await requireSession(request, id);
  if (gate instanceof NextResponse) return gate;

  const parsed = seedsSchema.safeParse(await readJson(request));
  if (!parsed.success) return jsonError("invalid_body", 400);

  const existing = await prisma.session.findUnique({ where: { id } });
  if (!existing) return jsonError("not_found", 404);

  const seeds = await prisma.$transaction(async (tx) => {
    await tx.seed.deleteMany({ where: { sessionId: id } });
    const created = [];
    for (const seed of parsed.data.seeds) {
      created.push(
        await tx.seed.create({
          data: {
            sessionId: id,
            rawText: seed.rawText,
            source: seed.source,
          },
        }),
      );
    }
    await tx.session.update({
      where: { id },
      data: { lastActiveAt: new Date() },
    });
    return created;
  });

  return NextResponse.json({ seeds });
}

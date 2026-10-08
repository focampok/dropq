import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { jsonError, readJson } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requireSession } from "@/lib/session/require";
import { patchSessionSchema } from "@/lib/session/schema";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const limited = enforceRateLimit(request, "other");
  if (limited) return limited;
  const { id } = await context.params;
  const gate = await requireSession(request, id);
  if (gate instanceof NextResponse) return gate;

  const parsed = patchSessionSchema.safeParse(await readJson(request));
  if (!parsed.success) return jsonError("invalid_body", 400);

  const existing = await prisma.session.findUnique({ where: { id } });
  if (!existing) return jsonError("not_found", 404);

  const session = await prisma.session.update({
    where: { id },
    data: {
      lastActiveAt: new Date(),
      ...(parsed.data.city ? { city: parsed.data.city } : {}),
      ...(parsed.data.eventKind ? { eventKind: parsed.data.eventKind } : {}),
      ...(parsed.data.locale ? { locale: parsed.data.locale } : {}),
    },
  });

  return NextResponse.json(session);
}

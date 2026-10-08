import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { QlooQuotaError } from "@/lib/qloo/types";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requireSession } from "@/lib/session/require";
import { resolveOnly } from "@/lib/pipeline/run";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const limited = enforceRateLimit(request, "other");
  if (limited) return limited;
  const { id } = await context.params;
  const gate = await requireSession(request, id);
  if (gate instanceof NextResponse) return gate;
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session) return jsonError("not_found", 404);
  try {
    const anchors = await resolveOnly(id);
    return NextResponse.json({ anchors });
  } catch (error) {
    if (error instanceof QlooQuotaError) {
      return NextResponse.json(
        {
          error: "QUOTA_LOW",
          en: "Live data is temporarily limited; try a preset.",
          es: "Los datos en vivo están limitados por ahora; prueba un preset.",
        },
        { status: 503 },
      );
    }
    return jsonError("failed", 500);
  }
}

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { jsonError, readJsonBody, safeServerError } from "@/lib/http";
import { QlooQuotaError } from "@/lib/qloo/types";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requireSession } from "@/lib/session/require";
import { packInputSchema } from "@/lib/session/schema";
import { resolveOnly } from "@/lib/pipeline/run";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const limited = enforceRateLimit(request, "other");
  if (limited) return limited;
  const { id } = await context.params;
  const gate = await requireSession(request, id);
  if (gate instanceof NextResponse) return gate;

  try {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    if (body.value !== null) {
      const parsed = packInputSchema.safeParse(body.value);
      if (!parsed.success) return jsonError("invalid_body", 400);
    }
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) return jsonError("not_found", 404);
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
    return safeServerError(error, "resolve_failed");
  }
}

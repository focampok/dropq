import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { markLiveGeneration, refuseCustomLive } from "@/lib/abuse";
import { jsonError, readJsonBody, safeServerError } from "@/lib/http";
import { qlooApiKey } from "@/lib/qloo/config";
import { qlooQuota } from "@/lib/qloo/client";
import { QlooQuotaError } from "@/lib/qloo/types";
import { enforceRateLimit } from "@/lib/rate-limit";
import { runPipeline } from "@/lib/pipeline/run";
import { requireSession } from "@/lib/session/require";
import { packInputSchema } from "@/lib/session/schema";

type RouteContext = { params: Promise<{ id: string }> };

const quotaBody = {
  error: "QUOTA_LOW",
  en: "Live data is temporarily limited; try a preset.",
  es: "Los datos en vivo están limitados por ahora; prueba un preset.",
};

export async function POST(request: Request, context: RouteContext) {
  // Live path rated as pack_live; cache hits (T3) will re-check as pack_cheap.
  const limited = enforceRateLimit(request, "pack_live");
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

    const session = await prisma.session.findUnique({
      where: { id },
      include: { seeds: { orderBy: { id: "asc" } } },
    });
    if (!session) return jsonError("not_found", 404);
    if (qlooApiKey() && qlooQuota().blocked) {
      return NextResponse.json(quotaBody, { status: 503 });
    }

    const resting = refuseCustomLive(session.seeds);
    if (resting) return resting;
    markLiveGeneration(session.seeds);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event: unknown) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        try {
          await runPipeline(id, emit, request.signal);
        } catch (error) {
          emit({
            step: "error",
            status: "error",
            detail: error instanceof QlooQuotaError ? "QUOTA_LOW" : "failed",
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return safeServerError(error, "pack_failed");
  }
}

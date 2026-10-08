import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { qlooApiKey } from "@/lib/qloo/config";
import { qlooQuota } from "@/lib/qloo/client";
import { QlooQuotaError } from "@/lib/qloo/types";
import { enforceRateLimit } from "@/lib/rate-limit";
import { runPipeline } from "@/lib/pipeline/run";
import { requireSession } from "@/lib/session/require";

type RouteContext = { params: Promise<{ id: string }> };

const quotaBody = {
  error: "QUOTA_LOW",
  en: "Live data is temporarily limited; try a preset.",
  es: "Los datos en vivo están limitados por ahora; prueba un preset.",
};

export async function POST(request: Request, context: RouteContext) {
  const limited = enforceRateLimit(request, "pack");
  if (limited) return limited;
  const { id } = await context.params;
  const gate = await requireSession(request, id);
  if (gate instanceof NextResponse) return gate;
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session) return jsonError("not_found", 404);
  if (qlooApiKey() && qlooQuota().blocked) {
    return NextResponse.json(quotaBody, { status: 503 });
  }

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
}

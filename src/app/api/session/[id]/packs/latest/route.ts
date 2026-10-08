import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requireSession } from "@/lib/session/require";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const limited = enforceRateLimit(request, "other");
  if (limited) return limited;
  const { id } = await context.params;
  const gate = await requireSession(request, id);
  if (gate instanceof NextResponse) return gate;

  const session = await prisma.session.findUnique({
    where: { id },
    include: {
      seeds: { orderBy: { id: "asc" } },
      packs: { include: { items: { orderBy: { position: "asc" } } }, orderBy: { label: "asc" } },
    },
  });
  if (!session) return jsonError("not_found", 404);

  return NextResponse.json({
    city: session.city,
    eventKind: session.eventKind,
    locale: session.locale,
    anchors: session.seeds.map((seed) => ({
      rawText: seed.rawText,
      resolvedName: seed.resolvedName,
      type: seed.domain,
      entityId: seed.resolvedEntityId,
    })),
    plans: session.packs.map((pack) => ({
      id: pack.id,
      label: pack.label,
      axis: pack.axis,
      narrative: pack.narrative,
      coverage: pack.coverage,
      items: pack.items.map((item) => ({
        slot: item.slot,
        hop: item.hop,
        entityId: item.qlooEntityId,
        name: item.qlooName,
        type: item.qlooType,
        imageUrl: item.imageUrl,
        affinityScore: item.affinityScore,
        explain: item.explain,
        evidence: item.evidence,
        confidence: item.confidence,
        provenance: item.provenance,
      })),
    })),
  });
}

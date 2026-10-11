import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requireSession } from "@/lib/session/require";

type RouteContext = { params: Promise<{ id: string }> };

type PackLlm = {
  anchors: "llm" | "fallback";
  anchorSource: "llm" | "rule_b_fallback";
  narrative: "llm" | "template";
  headline: string;
  provider: string | null;
  off: string | null;
  offReason: string | null;
  modelUsed: { anchors: string | null; narrative: string | null };
  attempts: { anchors: number; narrative: number };
  chainTried: { anchors: string[]; narrative: string[] };
  latencyMs: { anchors: number; narrative: number };
  calls: number;
  failures: string[];
  ruleB?: unknown;
};

function packLlm(coverage: unknown): PackLlm | null {
  if (!coverage || typeof coverage !== "object") return null;
  const llm = (coverage as { llm?: unknown }).llm;
  if (!llm || typeof llm !== "object") return null;
  const anchors = (llm as { anchors?: unknown }).anchors;
  const narrative = (llm as { narrative?: unknown }).narrative;
  if ((anchors !== "llm" && anchors !== "fallback") || (narrative !== "llm" && narrative !== "template")) return null;
  const anchorSource = (llm as { anchorSource?: unknown }).anchorSource;
  const headline = (llm as { headline?: unknown }).headline;
  const provider = (llm as { provider?: unknown }).provider;
  const offReason = (llm as { offReason?: unknown }).offReason;
  const off = (llm as { off?: unknown }).off;
  const failures = (llm as { failures?: unknown }).failures;
  const modelUsed = sideIds((llm as { modelUsed?: unknown }).modelUsed);
  const attempts = sideCounts((llm as { attempts?: unknown }).attempts);
  const chainTried = sideLists((llm as { chainTried?: unknown }).chainTried);
  const latencyMs = sideCounts((llm as { latencyMs?: unknown }).latencyMs);
  const calls = (llm as { calls?: unknown }).calls;
  return {
    anchors,
    narrative,
    anchorSource: anchorSource === "llm" ? "llm" : "rule_b_fallback",
    headline: typeof headline === "string" ? headline : "",
    provider: typeof provider === "string" ? provider : null,
    off: typeof off === "string" ? off : typeof offReason === "string" ? offReason : null,
    offReason: typeof offReason === "string" ? offReason : null,
    modelUsed,
    attempts,
    chainTried,
    latencyMs,
    calls: typeof calls === "number" ? calls : attempts.anchors + attempts.narrative,
    failures: Array.isArray(failures) ? failures.filter((code): code is string => typeof code === "string") : [],
    ruleB: (coverage as { ruleB?: unknown }).ruleB,
  };
}

function sideIds(value: unknown): { anchors: string | null; narrative: string | null } {
  const record = value && typeof value === "object" ? (value as { anchors?: unknown; narrative?: unknown }) : {};
  return {
    anchors: typeof record.anchors === "string" ? record.anchors : null,
    narrative: typeof record.narrative === "string" ? record.narrative : null,
  };
}

function sideCounts(value: unknown): { anchors: number; narrative: number } {
  const record = value && typeof value === "object" ? (value as { anchors?: unknown; narrative?: unknown }) : {};
  return {
    anchors: typeof record.anchors === "number" ? record.anchors : 0,
    narrative: typeof record.narrative === "number" ? record.narrative : 0,
  };
}

function sideLists(value: unknown): { anchors: string[]; narrative: string[] } {
  const record = value && typeof value === "object" ? (value as { anchors?: unknown; narrative?: unknown }) : {};
  const list = (entry: unknown) => (Array.isArray(entry) ? entry.filter((item): item is string => typeof item === "string") : []);
  return { anchors: list(record.anchors), narrative: list(record.narrative) };
}

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
      llm: packLlm(pack.coverage),
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

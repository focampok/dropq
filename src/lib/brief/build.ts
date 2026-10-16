import { isPresetSession } from "@/lib/abuse";
import { readBaselineCache } from "@/lib/baseline/cache";
import { baselineSignature } from "@/lib/baseline/signature";
import { evidenceLineFromStored, isSlotName } from "@/lib/brief/evidence";
import type { BriefBuildCounters, BriefItem, BriefPayload, BriefPlan } from "@/lib/brief/types";
import { prisma } from "@/lib/db";
import { getDictionary, type Locale } from "@/lib/i18n";
import { geminiCallCount } from "@/lib/llm/gemini-chain";
import { PINNED_PRESETS } from "@/lib/pipeline/config";
import { observedQlooCalls } from "@/lib/qloo/client";
import { SLOTS } from "@/lib/pack/assemble";

type PackRow = {
  id: string;
  label: string;
  axis: string;
  narrative: string | null;
  coverage: unknown;
  items: {
    slot: string;
    hop: number;
    qlooEntityId: string;
    qlooName: string;
    qlooType: string;
    explain: string | null;
    confidence: string;
    evidence: unknown;
    position: number;
  }[];
};

type SessionRow = {
  id: string;
  city: string;
  eventKind: string | null;
  locale: string;
  seeds: {
    rawText: string;
    resolvedName: string | null;
    domain: string;
    resolvedEntityId: string | null;
  }[];
  packs: PackRow[];
};

function narrationSource(coverage: unknown): "llm" | "template" {
  if (!coverage || typeof coverage !== "object") return "template";
  const llm = (coverage as { llm?: { narrative?: unknown } }).llm;
  return llm?.narrative === "llm" ? "llm" : "template";
}

function headlineOf(coverage: unknown): string {
  if (!coverage || typeof coverage !== "object") return "";
  const llm = (coverage as { llm?: { headline?: unknown } }).llm;
  return typeof llm?.headline === "string" ? llm.headline : "";
}

function coverageNote(coverage: unknown, locale: Locale): string {
  if (!coverage || typeof coverage !== "object") return "";
  const notes = (coverage as { notes?: { en?: unknown; es?: unknown } }).notes;
  if (!notes || typeof notes !== "object") return "";
  const value = locale === "es" ? notes.es : notes.en;
  return typeof value === "string" ? value : "";
}

function pinnedEntityIds(texts: string[]): string[] | null {
  const preset = PINNED_PRESETS.find(
    (entry) =>
      entry.seeds.length === texts.length &&
      entry.seeds.every((seed, index) => seed.rawText === texts[index]),
  );
  if (!preset) return null;
  const ids = preset.seeds.map((seed) => seed.entityId).filter((id): id is string => Boolean(id));
  return ids.length === preset.seeds.length ? ids : null;
}

function toConfidence(value: string): BriefItem["confidence"] {
  if (value === "high" || value === "medium" || value === "low" || value === "unverified") {
    return value;
  }
  return "unverified";
}

function toPlan(pack: PackRow, locale: Locale): BriefPlan {
  const bySlot = new Map(pack.items.map((item) => [item.slot, item]));
  const items: BriefItem[] = SLOTS.flatMap((slot) => {
    const item = bySlot.get(slot);
    if (!item || !isSlotName(item.slot)) return [];
    const evidence =
      item.evidence && typeof item.evidence === "object"
        ? (item.evidence as Record<string, unknown>)
        : null;
    return [
      {
        slot,
        name: item.qlooName,
        entityId: item.qlooEntityId,
        type: item.qlooType,
        hop: item.hop,
        explain: item.explain?.trim() ?? "",
        evidenceLine: evidenceLineFromStored(evidence, locale),
        confidence: toConfidence(item.confidence),
        chosenForCity: evidence?.chosenByCity === true,
      },
    ];
  });
  return {
    label: pack.label === "B" ? "B" : "A",
    axis: pack.axis,
    narrative: pack.narrative,
    headline: headlineOf(pack.coverage),
    narrationSource: narrationSource(pack.coverage),
    items,
  };
}

/**
 * Pure assembly from already-loaded session rows. Never calls Qloo or Gemini.
 */
export function assembleBrief(input: {
  packId: string;
  session: SessionRow;
  locale: Locale;
  baseline: BriefPayload["baseline"];
  generatedAt?: Date;
}): BriefPayload {
  const locale = input.locale === "es" ? "es" : "en";
  const packs = [...input.session.packs].sort((left, right) => left.label.localeCompare(right.label));
  const primaryCoverage = packs[0]?.coverage;
  return {
    packId: input.packId,
    sessionId: input.session.id,
    locale,
    city: input.session.city,
    eventKind: input.session.eventKind ?? "tour",
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    isPreset: isPresetSession(input.session.seeds),
    anchors: input.session.seeds.map((seed) => ({
      rawText: seed.rawText,
      resolvedName: seed.resolvedName,
      type: seed.domain,
      entityId: seed.resolvedEntityId,
      unverified: !seed.resolvedEntityId,
    })),
    plans: packs.map((pack) => toPlan(pack, locale)),
    coverageNote: coverageNote(primaryCoverage, locale),
    baseline: input.baseline,
  };
}

export type BriefLoadResult =
  | { ok: true; payload: BriefPayload; counters: BriefBuildCounters }
  | { ok: false; status: 404; counters: BriefBuildCounters };

/**
 * Load a brief for one pack id. Read-only: finds rows and optionally a stored baseline.
 * Callers enforce access before/after via `authorizeBriefAccess`.
 */
export async function loadBrief(input: {
  packId: string;
  locale: Locale;
  includeBaseline?: boolean;
}): Promise<BriefLoadResult> {
  const qlooBefore = observedQlooCalls();
  const geminiBefore = geminiCallCount();
  const writes = 0;

  const pack = await prisma.pack.findUnique({
    where: { id: input.packId },
    select: { id: true, sessionId: true },
  });
  if (!pack) {
    return {
      ok: false,
      status: 404,
      counters: {
        qlooBefore,
        geminiBefore,
        qlooAfter: observedQlooCalls(),
        geminiAfter: geminiCallCount(),
        writes,
      },
    };
  }

  const session = await prisma.session.findUnique({
    where: { id: pack.sessionId },
    include: {
      seeds: { orderBy: { id: "asc" } },
      packs: {
        include: { items: { orderBy: { position: "asc" } } },
        orderBy: { label: "asc" },
      },
    },
  });
  if (!session || session.packs.length === 0) {
    return {
      ok: false,
      status: 404,
      counters: {
        qlooBefore,
        geminiBefore,
        qlooAfter: observedQlooCalls(),
        geminiAfter: geminiCallCount(),
        writes,
      },
    };
  }

  const locale = input.locale === "es" ? "es" : "en";
  let baseline: BriefPayload["baseline"] = null;
  if (input.includeBaseline !== false) {
    const texts = session.seeds.map((seed) => seed.rawText);
    const pinned = pinnedEntityIds(texts);
    const entityIds =
      pinned ??
      session.seeds
        .map((seed) => seed.resolvedEntityId)
        .filter((value): value is string => Boolean(value));
    if (entityIds.length > 0) {
      const { signature } = baselineSignature({
        entityIds,
        city: session.city,
        eventKind: session.eventKind ?? "tour",
        locale,
        mode: "default",
      });
      const hit = await readBaselineCache(signature);
      baseline = hit?.payload ?? null;
    }
  }

  const payload = assembleBrief({
    packId: input.packId,
    session,
    locale,
    baseline,
  });

  // Touch dictionary so locale-only string assembly stays in-process (no I/O).
  void getDictionary(locale).brief.title;

  return {
    ok: true,
    payload,
    counters: {
      qlooBefore,
      geminiBefore,
      qlooAfter: observedQlooCalls(),
      geminiAfter: geminiCallCount(),
      writes,
    },
  };
}

export function countersClean(counters: BriefBuildCounters): boolean {
  return (
    counters.qlooAfter === counters.qlooBefore &&
    counters.geminiAfter === counters.geminiBefore &&
    counters.writes === 0
  );
}

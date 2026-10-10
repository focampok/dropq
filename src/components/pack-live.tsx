"use client";

import { useEffect, useState } from "react";
import { PackView } from "@/components/pack-view";
import { getDictionary, type Locale } from "@/lib/i18n";
import type { StepId } from "@/lib/i18n/types";
import type { AssembledPack } from "@/lib/pack/assemble";

type StepState = "pending" | "active" | "done" | "skipped" | "error";

type Latest = {
  city: string;
  eventKind: "tour" | "con" | "comunidad" | null;
  anchors: { rawText: string; resolvedName: string | null; type: string; entityId: string | null }[];
  plans: {
    label: "A" | "B";
    axis: "root" | "bridge";
    narrative: string | null;
    llm?: { anchors: "llm" | "fallback"; narrative: "llm" | "template" } | null;
    coverage: { notes?: { en?: string; es?: string }; mode?: "default" | "deep_cuts" } | null;
    items: {
      slot: "watch" | "listen" | "wear" | "do";
      hop: number;
      entityId: string;
      name: string;
      type: string;
      imageUrl: string | null;
      affinityScore: number | null;
      explain: string | null;
      evidence: Record<string, unknown> | null;
      confidence: "high" | "medium" | "low" | "unverified";
      provenance: "qloo" | "mock";
    }[];
  }[];
};

export function PackLive({ locale, sessionId }: { locale: Locale; sessionId: string }) {
  const dictionary = getDictionary(locale);
  const [steps, setSteps] = useState<Partial<Record<StepId, StepState>>>({});
  const [pack, setPack] = useState<AssembledPack | null>(null);
  const [anchors, setAnchors] = useState<Latest["anchors"]>([]);
  const [narratives, setNarratives] = useState<{ A?: string | null; B?: string | null }>({});
  const [aiNarrative, setAiNarrative] = useState<{ A?: boolean; B?: boolean }>({});
  const [error, setError] = useState<string | null>(null);
  const [bridgeMode, setBridgeMode] = useState<"default" | "deep_cuts">("default");
  const [bridgeBusy, setBridgeBusy] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setError(dictionary.onboarding.saveError);
      return;
    }
    const controller = new AbortController();
    void run(controller.signal);
    return () => controller.abort();

    async function run(signal: AbortSignal) {
      try {
        const response = await fetch(`/api/session/${sessionId}/pack`, { method: "POST", signal });
        if (response.status === 503) {
          setError(dictionary.pack.quotaLow);
          return;
        }
        if (!response.ok || !response.body) {
          setError(dictionary.onboarding.saveError);
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line) as { step?: string; status?: StepState; detail?: string };
            if (event.step === "error" && event.detail === "QUOTA_LOW") {
              setError(dictionary.pack.quotaLow);
            } else if (event.step && event.step !== "error" && event.status) {
              setSteps((current) => ({ ...current, [event.step as StepId]: event.status }));
            }
          }
        }
        const latest = await fetch(`/api/session/${sessionId}/packs/latest`, { signal });
        if (!latest.ok) return;
        const body = (await latest.json()) as Latest;
        setAnchors(body.anchors);
        setNarratives({ A: body.plans.find((plan) => plan.label === "A")?.narrative, B: body.plans.find((plan) => plan.label === "B")?.narrative });
        setAiNarrative(aiFlags(body));
        setPack(toPack(sessionId, body));
        setBridgeMode(modeOf(body));
        const note = body.plans[0]?.coverage?.notes?.[locale] ?? "";
        if (note.toLowerCase().includes("timed out") || note.toLowerCase().includes("agotó")) {
          setError(dictionary.pack.timeout);
        }
        if (body.anchors.length > 0 && body.anchors.every((anchor) => !anchor.entityId)) {
          setError(dictionary.pack.noAnchors);
        }
      } catch {
        if (!signal.aborted) setError(dictionary.onboarding.saveError);
      }
    }
  }, [dictionary, locale, sessionId]);

  async function refine(mode: "default" | "deep_cuts") {
    setBridgeBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/session/${sessionId}/pack/refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (response.status === 503) {
        setError(dictionary.pack.quotaLow);
        return;
      }
      if (!response.ok || !response.body) {
        setError(dictionary.onboarding.saveError);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { step?: string; status?: StepState; detail?: string };
          if (event.step === "error") {
            setError(event.detail === "QUOTA_LOW" ? dictionary.pack.quotaLow : dictionary.onboarding.saveError);
          } else if (event.step && event.status) {
            setSteps((current) => ({ ...current, [event.step as StepId]: event.status }));
          }
        }
      }
      const latest = await fetch(`/api/session/${sessionId}/packs/latest`);
      if (!latest.ok) return;
      const body = (await latest.json()) as Latest;
      setAnchors(body.anchors);
      setNarratives({
        A: body.plans.find((plan) => plan.label === "A")?.narrative,
        B: body.plans.find((plan) => plan.label === "B")?.narrative,
      });
      setAiNarrative(aiFlags(body));
      setPack(toPack(sessionId, body));
      setBridgeMode(modeOf(body));
    } catch {
      setError(dictionary.onboarding.saveError);
    } finally {
      setBridgeBusy(false);
    }
  }

  return (
    <PackView
      locale={locale}
      pack={pack}
      steps={steps}
      anchors={anchors}
      narratives={narratives}
      aiNarrative={aiNarrative}
      error={error}
      bridgeMode={bridgeMode}
      bridgeBusy={bridgeBusy}
      onBridgeMode={(mode) => void refine(mode)}
    />
  );
}

function aiFlags(body: Latest): { A?: boolean; B?: boolean } {
  return {
    A: body.plans.find((plan) => plan.label === "A")?.llm?.narrative === "llm",
    B: body.plans.find((plan) => plan.label === "B")?.llm?.narrative === "llm",
  };
}

function modeOf(body: Latest): "default" | "deep_cuts" {
  const coverage = body.plans.find((plan) => plan.label === "B")?.coverage;
  return coverage && "mode" in coverage && coverage.mode === "deep_cuts" ? "deep_cuts" : "default";
}

function toPack(sessionId: string, body: Latest): AssembledPack {
  const notes = body.plans[0]?.coverage?.notes;
  return {
    sessionId,
    city: body.city,
    eventKind: body.eventKind ?? "tour",
    seeds: body.anchors.flatMap((anchor) =>
      anchor.entityId ? [{ raw: anchor.rawText, entityId: anchor.entityId, type: anchor.type }] : [],
    ),
    packs: body.plans.map((plan) => ({
      label: plan.label,
      axis: plan.axis,
      items: plan.items.map((item) => ({
        slot: item.slot,
        entityId: item.entityId,
        name: item.name,
        type: item.type,
        hop: item.hop === 1 ? 1 : 0,
        imageUrl: item.slot === "do" ? null : item.imageUrl,
        affinity: item.affinityScore,
        explain: { en: item.explain || "—", es: item.explain || "—" },
        confidence: item.confidence,
        provenance: item.provenance,
        ...(item.evidence ? { evidence: item.evidence } : {}),
      })),
    })),
    coverage: {
      notes: { en: notes?.en ?? "", es: notes?.es ?? "" },
      removedFromBridge: [],
    },
  };
}

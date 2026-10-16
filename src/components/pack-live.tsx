"use client";

import { useCallback, useEffect, useState } from "react";
import { PackView } from "@/components/pack-view";
import { getDictionary, type Locale } from "@/lib/i18n";
import type { StepId } from "@/lib/i18n/types";
import type { AssembledPack } from "@/lib/pack/assemble";

type StepState = "pending" | "active" | "done" | "skipped" | "error";

export type PlanLlm = {
  anchors: "llm" | "fallback";
  anchorSource: "llm" | "rule_b_fallback";
  narrative: "llm" | "template";
  headline: string;
  provider: string | null;
  offReason: string | null;
  failures: string[];
  ruleB?: unknown;
};

type Latest = {
  city: string;
  eventKind: "tour" | "con" | "comunidad" | null;
  anchors: { rawText: string; resolvedName: string | null; type: string; entityId: string | null }[];
  plans: {
    label: "A" | "B";
    axis: "root" | "bridge";
    narrative: string | null;
    llm?: PlanLlm | null;
    coverage: {
      notes?: { en?: string; es?: string };
      mode?: "default" | "deep_cuts";
      cache?: { hit?: boolean; builtAt?: string };
    } | null;
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
  const [headlines, setHeadlines] = useState<{ A?: string; B?: string }>({});
  const [aiNarrative, setAiNarrative] = useState<{ A?: boolean; B?: boolean }>({});
  const [error, setError] = useState<string | null>(null);
  const [bridgeMode, setBridgeMode] = useState<"default" | "deep_cuts">("default");
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [cacheNote, setCacheNote] = useState<{ label: string; exact: string } | null>(null);

  // Applies one snapshot of the stored packs. It runs once at assemble, when only the
  // template narrative exists, and again at narrate, when the LLM text replaces it.
  const applyLatest = useCallback(
    (body: Latest) => {
      setAnchors(body.anchors);
      setNarratives({
        A: body.plans.find((plan) => plan.label === "A")?.narrative,
        B: body.plans.find((plan) => plan.label === "B")?.narrative,
      });
      setHeadlines({
        A: body.plans.find((plan) => plan.label === "A")?.llm?.headline || "",
        B: body.plans.find((plan) => plan.label === "B")?.llm?.headline || "",
      });
      setAiNarrative(aiFlags(body));
      setPack(toPack(sessionId, body));
      setBridgeMode(modeOf(body));
      const cache = body.plans[0]?.coverage?.cache;
      if (cache?.hit && cache.builtAt) {
        const when = relativeTime(cache.builtAt, locale);
        setCacheNote({
          label: dictionary.pack.cachedNote.replace("{when}", when),
          exact: new Date(cache.builtAt).toISOString(),
        });
      } else {
        setCacheNote(null);
      }
      return body;
    },
    [dictionary.pack.cachedNote, locale, sessionId],
  );

  useEffect(() => {
    if (!sessionId) {
      setError(dictionary.onboarding.saveError);
      return;
    }
    const controller = new AbortController();
    void run(controller.signal);
    return () => controller.abort();

    async function load(signal: AbortSignal): Promise<Latest | null> {
      // A cache-hit pack stream already paid the cheap limit; a brief 429 on the
      // follow-up read must not leave a blank page. Retry a few times, then surface it.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const latest = await fetch(`/api/session/${sessionId}/packs/latest`, { signal });
        if (latest.status === 429) {
          if (attempt === 3) {
            setError(dictionary.pack.rateLimited);
            return null;
          }
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
          continue;
        }
        if (!latest.ok) return null;
        return applyLatest((await latest.json()) as Latest);
      }
      return null;
    }

    async function run(signal: AbortSignal) {
      try {
        // The requested language travels with the request so a language toggle serves the
        // stored per-language pack instead of leaving the narration in the build language.
        const response = await fetch(`/api/session/${sessionId}/pack`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lang: locale }),
          signal,
        });
        if (response.status === 429) {
          setError(dictionary.pack.rateLimited);
          return;
        }
        if (response.status === 503) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error === "DEMO_RESTING" ? dictionary.pack.demoResting : dictionary.pack.quotaLow);
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
              if (event.step === "assemble" && event.status === "done") {
                // First paint: the pack is stored with the template narrative already.
                await load(signal);
              }
              if (event.step === "narrate" && event.status === "done") {
                await load(signal);
              }
            }
          }
        }
        const body = await load(signal);
        if (!body) return;
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
  }, [applyLatest, dictionary, locale, sessionId]);

  async function refine(mode: "default" | "deep_cuts") {
    setBridgeBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/session/${sessionId}/pack/refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (response.status === 429) {
        setError(dictionary.pack.rateLimited);
        return;
      }
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
            if (
              (event.step === "assemble" || event.step === "narrate") &&
              event.status === "done"
            ) {
              await load();
            }
          }
        }
      }
      await load();
    } catch {
      setError(dictionary.onboarding.saveError);
    } finally {
      setBridgeBusy(false);
    }

    async function load(): Promise<void> {
      const latest = await fetch(`/api/session/${sessionId}/packs/latest`);
      if (!latest.ok) return;
      applyLatest((await latest.json()) as Latest);
    }
  }

  return (
    <PackView
      locale={locale}
      pack={pack}
      sessionId={sessionId}
      steps={steps}
      anchors={anchors}
      narratives={narratives}
      headlines={headlines}
      aiNarrative={aiNarrative}
      error={error}
      bridgeMode={bridgeMode}
      bridgeBusy={bridgeBusy}
      onBridgeMode={(mode) => void refine(mode)}
      cacheNote={cacheNote}
    />
  );
}

function relativeTime(iso: string, locale: Locale): string {
  const then = new Date(iso).getTime();
  const delta = Math.max(0, Date.now() - then);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return locale === "es" ? "hace un momento" : "just now";
  if (minutes < 60) return locale === "es" ? `hace ${minutes} min` : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return locale === "es" ? `hace ${hours} h` : `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return locale === "es" ? `hace ${days} d` : `${days} d ago`;
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

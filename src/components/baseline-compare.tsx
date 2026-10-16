"use client";

import { useEffect, useRef, useState } from "react";
import { useHydrated } from "@/components/hydration";
import { Badge } from "@/components/ui/badge";
import { getDictionary, type Locale } from "@/lib/i18n";
import type { AssembledPack } from "@/lib/pack/assemble";
import type { BaselinePayload, BaselineSlot } from "@/lib/baseline/types";
import { BASELINE_SLOTS } from "@/lib/baseline/types";

type Props = {
  locale: Locale;
  sessionId: string;
  pack: AssembledPack | null;
};

export function BaselineCompare({ locale, sessionId, pack }: Props) {
  const dictionary = getDictionary(locale);
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<BaselinePayload | null>(null);
  const [cacheHeader, setCacheHeader] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setPayload(null);
    setError(null);
    setOpen(false);
    setCacheHeader(null);
    abortRef.current?.abort();
    abortRef.current = null;
  }, [locale, sessionId]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  async function run(): Promise<void> {
    if (!sessionId || loading) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/session/${sessionId}/pack/baseline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang: locale }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setCacheHeader(response.headers.get("x-dropq-cache"));
      if (response.status === 429) {
        setError(dictionary.pack.rateLimited);
        return;
      }
      if (response.status === 503) {
        setError(dictionary.pack.baselineUnavailable);
        return;
      }
      if (!response.ok) {
        setError(dictionary.pack.baselineUnavailable);
        return;
      }
      const body = (await response.json()) as BaselinePayload;
      setPayload(body);
    } catch {
      if (!controller.signal.aborted) setError(dictionary.pack.baselineUnavailable);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  const qlooBySlot = new Map<BaselineSlot, { name: string; entityId: string }>();
  if (pack) {
    for (const plan of pack.packs) {
      for (const item of plan.items) {
        if (!qlooBySlot.has(item.slot)) {
          qlooBySlot.set(item.slot, { name: item.name, entityId: item.entityId });
        }
      }
    }
  }

  return (
    <section className="mt-10" aria-label={dictionary.pack.baselineCompare} data-baseline-panel>
      <button
        type="button"
        disabled={!hydrated || !pack || loading}
        onClick={() => void run()}
        className="rounded border border-paper/25 px-3 py-2 text-sm text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp disabled:pointer-events-none disabled:opacity-50"
        data-baseline-compare
      >
        {loading ? dictionary.pack.baselineLoading : dictionary.pack.baselineCompare}
      </button>

      {open ? (
        <div className="mt-4" data-baseline-result data-cache={cacheHeader ?? ""}>
          {error ? (
            <p role="alert" className="text-sm text-paper/80">
              {error}
            </p>
          ) : null}
          {loading && !payload ? (
            <p className="text-sm text-paper/70" data-baseline-loading>
              {dictionary.pack.baselineLoading}
            </p>
          ) : null}
          {payload ? (
            <>
              <p className="text-sm text-paper/80" data-baseline-summary>
                {dictionary.pack.baselineSummary
                  .replace("{verified}", String(payload.summary.verified))
                  .replace("{inPack}", String(payload.summary.inPack))}
              </p>
              <p className="mt-1 text-xs text-paper/70">{dictionary.pack.baselineHonest}</p>
              <div className="mt-4 grid gap-6 md:grid-cols-2">
                <div>
                  <h2 className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-paper/70">
                    {dictionary.pack.baselineColumnLlm}
                    <Badge className="border-paper/50 bg-transparent text-paper">
                      {dictionary.pack.baselineAiBadge}
                    </Badge>
                  </h2>
                  <ul className="mt-3 space-y-3">
                    {BASELINE_SLOTS.map((slot) => {
                      const item = payload.llmItems.find((entry) => entry.slot === slot);
                      const verify = payload.verification.find((entry) => entry.slot === slot);
                      return (
                        <li key={slot} className="border-b border-paper/10 pb-3" data-baseline-slot={slot}>
                          <p className="text-xs uppercase tracking-wide text-paper/70">
                            {dictionary.slots[slot]}
                          </p>
                          <p className="mt-1 text-sm text-paper">{item?.name ?? "—"}</p>
                          <div className="mt-1 flex flex-wrap gap-2 text-xs">
                            {verify?.status === "verified" ? (
                              <span className="text-stamp" data-status="verified">
                                {dictionary.pack.baselineVerified}
                                {verify.resolvedName ? ` · ${verify.resolvedName}` : ""}
                              </span>
                            ) : (
                              <span className="text-paper/70" data-status="not_verifiable">
                                {dictionary.pack.baselineNotVerifiable}
                              </span>
                            )}
                            {verify?.inPack ? (
                              <span className="text-paper/80" data-in-pack="yes">
                                {dictionary.pack.baselineAlsoInPack}
                              </span>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
                <div>
                  <h2 className="text-xs uppercase tracking-[0.18em] text-paper/70">
                    {dictionary.pack.baselineColumnQloo}
                  </h2>
                  <ul className="mt-3 space-y-3">
                    {BASELINE_SLOTS.map((slot) => {
                      const card = qlooBySlot.get(slot);
                      return (
                        <li key={slot} className="border-b border-paper/10 pb-3">
                          <p className="text-xs uppercase tracking-wide text-paper/70">
                            {dictionary.slots[slot]}
                          </p>
                          <p className="mt-1 text-sm text-paper">{card?.name ?? "—"}</p>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

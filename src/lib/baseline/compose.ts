import { z } from "zod";
import { geminiQuotaBlocked, readStructured } from "@/lib/pipeline/llm";
import { llmConfigured, llmStatus } from "@/lib/llm/provider";
import { llmHourlyAllowed } from "@/lib/rate-limit";
import { BASELINE_SLOTS, type BaselineLlmItem, type BaselineSource } from "@/lib/baseline/types";

const BASELINE_TIMEOUT_MS = 12_000;
const BASELINE_ATTEMPT_CAP_MS = 6_000;

const baselineSchema = z.object({
  watch: z.string().min(1).max(120),
  listen: z.string().min(1).max(120),
  wear: z.string().min(1).max(120),
  do: z.string().min(1).max(120),
});

export type BaselineComposeResult =
  | { ok: true; items: BaselineLlmItem[]; source: BaselineSource; ms: number }
  | { ok: false; reason: "unavailable" | "quota" | "llm_error"; ms: number };

function prompt(input: {
  locale: "en" | "es";
  city: string;
  eventKind: string;
  anchors: string[];
}): string {
  const language = input.locale === "es" ? "Spanish" : "English";
  return [
    `Propose one real cultural pick per slot for a night-out pack. Answer in ${language}.`,
    "No tools. Use only public knowledge. Do not invent Qloo ids.",
    `City: ${input.city}`,
    `Event kind: ${input.eventKind}`,
    `Audience anchors: ${input.anchors.join(", ")}`,
    "Slots: watch (a TV show), listen (an artist), wear (a clothing/apparel brand), do (a place or venue in or near the city).",
    'Return JSON only: {"watch":"...","listen":"...","wear":"...","do":"..."} with specific real names.',
  ].join("\n");
}

/**
 * One tool-free LLM call for four slot names. Never fabricates a baseline when the
 * chain is unavailable — callers return 503 instead.
 */
export async function composeBaselineItems(input: {
  locale: "en" | "es";
  city: string;
  eventKind: string;
  anchors: string[];
}): Promise<BaselineComposeResult> {
  const started = Date.now();
  const status = llmStatus();
  if (!llmConfigured() || status.offReason === "hourly_cap" || !llmHourlyAllowed()) {
    return { ok: false, reason: "unavailable", ms: Date.now() - started };
  }
  if (status.offReason || !status.provider) {
    return { ok: false, reason: "unavailable", ms: Date.now() - started };
  }
  if (geminiQuotaBlocked()) {
    return { ok: false, reason: "quota", ms: Date.now() - started };
  }
  try {
    const structured = await readStructured(
      prompt(input),
      baselineSchema,
      BASELINE_TIMEOUT_MS,
      {
        system:
          "You name real TV shows, artists, apparel brands and venues. JSON only. No commentary.",
        attemptCapMs: BASELINE_ATTEMPT_CAP_MS,
      },
    );
    const object = structured.object;
    const items: BaselineLlmItem[] = BASELINE_SLOTS.map((slot) => ({
      slot,
      name: object[slot].trim(),
    }));
    if (items.some((item) => !item.name)) {
      return { ok: false, reason: "llm_error", ms: Date.now() - started };
    }
    return { ok: true, items, source: "llm", ms: Date.now() - started };
  } catch {
    return { ok: false, reason: "llm_error", ms: Date.now() - started };
  }
}

import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, generateText } from "ai";
import { z, ZodError } from "zod";
import { getDictionary, type Locale } from "@/lib/i18n";
import { anchorsForRule, validAnchorIds, type AnchorCandidate } from "@/lib/pipeline/anchors";
import { BRIDGE_ANCHOR_RULE } from "@/lib/pipeline/config";

const idSchema = z.object({
  ids: z.array(z.string()).min(2).max(3),
});

const narrativeSchema = z.object({
  text: z.string().min(1),
});

export const LLM_TIMEOUT_MS = 15_000;

export type LlmFailure = "invalid_json" | "unknown_id" | "same_slot" | "unknown_name" | "timeout" | "request";

export type AnchorChoice = {
  ids: string[];
  source: "llm" | "fallback";
  failure?: LlmFailure;
  ms: number;
};

export type NarrativeChoice = {
  text: string;
  source: "llm" | "template";
  failure?: LlmFailure;
  ms: number;
};

export type CoverageLlm = {
  anchors: "llm" | "fallback";
  narrative: "llm" | "template";
};

export function llmConfigured(): boolean {
  return Boolean(
    process.env.NEBIUS_API_KEY?.trim() &&
      process.env.NEBIUS_BASE_URL?.trim() &&
      process.env.NEBIUS_MODEL?.trim(),
  );
}

function model() {
  const openai = createOpenAI({
    apiKey: process.env.NEBIUS_API_KEY,
    baseURL: process.env.NEBIUS_BASE_URL,
  });
  return openai(process.env.NEBIUS_MODEL ?? "");
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), LLM_TIMEOUT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function failureClass(error: unknown): LlmFailure {
  if (error instanceof Error && error.message === "timeout") return "timeout";
  if (error instanceof ZodError || error instanceof SyntaxError) return "invalid_json";
  if (error instanceof Error && error.message === "no json") return "invalid_json";
  return "request";
}

async function readStructured<T>(prompt: string, schema: z.ZodType<T>): Promise<T> {
  try {
    const result = await withTimeout(generateObject({ model: model(), schema, prompt }));
    return result.object;
  } catch (error) {
    if (error instanceof Error && error.message === "timeout") throw error;
    const result = await withTimeout(generateText({ model: model(), prompt }));
    const start = result.text.indexOf("{");
    const end = result.text.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("no json");
    return schema.parse(JSON.parse(result.text.slice(start, end + 1)));
  }
}

function anchorFailure(candidates: AnchorCandidate[], ids: string[]): LlmFailure {
  if (ids.some((id) => !candidates.some((candidate) => candidate.id === id))) return "unknown_id";
  return "same_slot";
}

export async function chooseBridgeAnchors(
  candidates: AnchorCandidate[],
  seedTags: Set<string> = new Set(),
  rule: "A" | "B" = BRIDGE_ANCHOR_RULE,
): Promise<AnchorChoice> {
  const fallback = anchorsForRule(candidates, seedTags, rule);
  if (!llmConfigured() || candidates.length === 0) return { ids: fallback, source: "fallback", ms: 0 };
  const started = Date.now();
  try {
    const object = await readStructured(
      `Choose 2 or 3 ids from this list. They must be in the list and from different slots. Return JSON {"ids":["..."]}. ${JSON.stringify(candidates.map((candidate) => ({ id: candidate.id, name: candidate.name, slot: candidate.slot, tags: candidate.tags.slice(0, 8) })))}`,
      idSchema,
    );
    const ids = validAnchorIds(candidates, object.ids);
    if (!ids) {
      return { ids: fallback, source: "fallback", failure: anchorFailure(candidates, object.ids), ms: Date.now() - started };
    }
    return { ids, source: "llm", ms: Date.now() - started };
  } catch (error) {
    return { ids: fallback, source: "fallback", failure: failureClass(error), ms: Date.now() - started };
  }
}

export async function pickBridgeAnchors(
  candidates: AnchorCandidate[],
  seedTags: Set<string> = new Set(),
  rule: "A" | "B" = BRIDGE_ANCHOR_RULE,
): Promise<string[]> {
  const choice = await chooseBridgeAnchors(candidates, seedTags, rule);
  return choice.ids;
}

export function templateNarrative(locale: Locale, names: string[]): string {
  const dictionary = getDictionary(locale);
  if (names.length === 0) return dictionary.pack.narrativeEmpty;
  return dictionary.pack.narrativeTemplate.replace("{names}", names.join(", "));
}

export function narrativeUsesOnlyKnownNames(text: string, allowed: string[]): boolean {
  const corpus = allowed.join(" ").toLowerCase();
  const words = text.match(/\p{Lu}[\p{L}'’.-]{2,}/gu) ?? [];
  const stop = new Set(["tonight", "the", "this", "with", "and", "for", "from", "esta", "noche", "con", "para"]);
  return words.every((word) => {
    const cleaned = word.toLowerCase().replace(/[.'’-]+$/g, "");
    return stop.has(cleaned) || corpus.includes(cleaned);
  });
}

export async function composeNarrative(input: {
  locale: Locale;
  names: string[];
  allowed: string[];
}): Promise<NarrativeChoice> {
  const fallback = templateNarrative(input.locale, input.names);
  if (!llmConfigured() || input.names.length === 0) return { text: fallback, source: "template", ms: 0 };
  const started = Date.now();
  try {
    const object = await readStructured(
      `Write 2 or 3 sentences in ${input.locale === "es" ? "Spanish" : "English"} about only these items: ${input.names.join(", ")}. Do not add names. Return JSON {"text":"..."}.`,
      narrativeSchema,
    );
    if (!narrativeUsesOnlyKnownNames(object.text, input.allowed)) {
      return { text: fallback, source: "template", failure: "unknown_name", ms: Date.now() - started };
    }
    return { text: object.text, source: "llm", ms: Date.now() - started };
  } catch (error) {
    return { text: fallback, source: "template", failure: failureClass(error), ms: Date.now() - started };
  }
}

export async function narratePlan(input: {
  locale: Locale;
  names: string[];
  allowed: string[];
}): Promise<string> {
  const choice = await composeNarrative(input);
  return choice.text;
}

import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { getDictionary, type Locale } from "@/lib/i18n";
import {
  deterministicAnchors,
  validAnchorIds,
  type AnchorCandidate,
} from "@/lib/pipeline/anchors";

const idSchema = z.object({
  ids: z.array(z.string()).min(2).max(3),
});

const narrativeSchema = z.object({
  text: z.string().min(1),
});

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

async function readStructured<T>(prompt: string, schema: z.ZodType<T>): Promise<T> {
  try {
    const result = await generateObject({ model: model(), schema, prompt });
    return result.object;
  } catch {
    const result = await generateText({ model: model(), prompt });
    const start = result.text.indexOf("{");
    const end = result.text.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("no json");
    return schema.parse(JSON.parse(result.text.slice(start, end + 1)));
  }
}

export async function pickBridgeAnchors(candidates: AnchorCandidate[]): Promise<string[]> {
  const fallback = deterministicAnchors(candidates);
  if (!llmConfigured() || candidates.length === 0) return fallback;
  try {
    const object = await readStructured(
      `Choose 2 or 3 ids from this list. They must be in the list and from different slots. Return JSON {"ids":["..."]}. ${JSON.stringify(candidates.map((candidate) => ({ id: candidate.id, name: candidate.name, slot: candidate.slot, tags: candidate.tags.slice(0, 8) })))}`,
      idSchema,
    );
    return validAnchorIds(candidates, object.ids) ?? fallback;
  } catch {
    return fallback;
  }
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

export async function narratePlan(input: {
  locale: Locale;
  names: string[];
  allowed: string[];
}): Promise<string> {
  const fallback = templateNarrative(input.locale, input.names);
  if (!llmConfigured() || input.names.length === 0) return fallback;
  try {
    const object = await readStructured(
      `Write 2 or 3 sentences in ${input.locale === "es" ? "Spanish" : "English"} about only these items: ${input.names.join(", ")}. Do not add names. Return JSON {"text":"..."}.`,
      narrativeSchema,
    );
    if (!narrativeUsesOnlyKnownNames(object.text, input.allowed)) return fallback;
    return object.text;
  } catch {
    return fallback;
  }
}

import { generateObject } from "ai";
import { z } from "zod";
import { getDictionary, type Locale } from "@/lib/i18n";
import {
  anchorsForRule,
  anchorEvidence,
  closedAnchorList,
  type AnchorCandidate,
  type RankedAnchor,
} from "@/lib/pipeline/anchors";
import { BRIDGE_ANCHOR_RULE } from "@/lib/pipeline/config";
import { llmModelState, type LlmProviderId } from "@/lib/llm/provider";

export const LLM_TIMEOUT_MS = 12_000;
/** Anchor choice happens before assemble, so it gets a tighter budget. */
export const ANCHOR_TIMEOUT_MS = 6_000;

const TEMPERATURE = 0.2;
/** One SDK-level retry only; the narrative step adds at most one repair retry on top. */
const MAX_RETRIES = 1;
const TIMEOUT_CODE = "timeout";

export const MAX_NARRATIVE_CHARS = 280;
export const MAX_NARRATIVE_SENTENCES = 2;
export const MAX_HEADLINE_CHARS = 60;

export const NARRATIVE_TOKENS = [
  "watch",
  "listen",
  "wear",
  "do",
  "anchor1",
  "anchor2",
  "anchor3",
  "city",
] as const;

export type NarrativeToken = (typeof NARRATIVE_TOKENS)[number];

export type LlmFailure =
  | "invalid_json"
  | "unknown_id"
  | "same_slot"
  | "timeout"
  | "request"
  | "unknown_token"
  | "repeated_token"
  | "too_long"
  | "too_many_sentences"
  | "url"
  | "wrong_language"
  | "empty";

export type AnchorSource = "llm" | "rule_b_fallback";

export type AnchorChoice = {
  ids: string[];
  source: "llm" | "fallback";
  anchorSource: AnchorSource;
  evidence: RankedAnchor[];
  reason?: string;
  failure?: LlmFailure;
  ms: number;
};

export type NarrativePlanInput = {
  label: "A" | "B";
  city: string;
  anchors: { name: string }[];
  slots: Partial<Record<NarrativeToken, string>>;
};

export type PlanNarrative = {
  label: "A" | "B";
  text: string;
  headline: string;
  source: "llm" | "template";
};

export type NarrativesChoice = {
  plans: PlanNarrative[];
  provider: LlmProviderId | null;
  offReason: string | null;
  failures: LlmFailure[];
  ms: number;
};

export function llmConfigured(): boolean {
  return llmModelState().configured;
}

export function llmOffReason(): string | null {
  const state = llmModelState();
  return state.configured ? null : state.reason;
}

function withTimeout<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(TIMEOUT_CODE));
    }, ms);
    work(controller.signal).then(
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
  if (error instanceof Error && error.message === TIMEOUT_CODE) return "timeout";
  if (error instanceof z.ZodError || error instanceof SyntaxError) return "invalid_json";
  return "request";
}

/** Every validated call goes through generateObject; nothing free-text is parsed later. */
async function readStructured<T>(
  prompt: string,
  schema: z.ZodType<T>,
  timeoutMs: number,
): Promise<T> {
  const state = llmModelState();
  if (!state.configured) throw new Error("llm_not_configured");
  const result = await withTimeout(timeoutMs, (abortSignal) =>
    generateObject({
      model: state.model,
      schema,
      prompt,
      temperature: TEMPERATURE,
      maxRetries: MAX_RETRIES,
      abortSignal,
    }),
  );
  return result.object;
}

const anchorSchema = z.object({
  anchorIds: z.array(z.string()).min(2).max(3),
  reason: z.string().max(140),
});

export function anchorFailure(closed: readonly { id: string; slot: string }[], ids: string[]): LlmFailure {
  if (ids.some((id) => !closed.some((anchor) => anchor.id === id))) return "unknown_id";
  const slots = new Set<string>();
  for (const id of ids) {
    const match = closed.find((anchor) => anchor.id === id);
    if (!match || slots.has(match.slot)) return "same_slot";
    slots.add(match.slot);
  }
  return "same_slot";
}

function anchorPrompt(closed: RankedAnchor[]): string {
  const list = closed.map((anchor, index) => ({
    index: index + 1,
    id: anchor.id,
    slot: anchor.slot,
    name: anchor.name,
    sharedTags: anchor.sharedTags,
    sharedTagCount: anchor.sharedTagCount,
  }));
  return [
    "You pick the anchor entities for the second half of a night out.",
    "Choose 2 or 3 ids from the closed list below. Every id must come from this list:",
    "never invent a name, never return an id that is not listed, and never pick two ids from the same slot.",
    "Return JSON only: {\"anchorIds\": [\"<id>\"], \"reason\": \"<=140 characters\"}.",
    `Closed list: ${JSON.stringify(list)}`,
  ].join("\n");
}

/**
 * The LLM may only re-rank rule B's own candidates. Anything else falls back to
 * rule B's deterministic choice, with the failure recorded for the coverage note.
 */
export async function chooseBridgeAnchors(
  candidates: AnchorCandidate[],
  seedTags: Set<string> = new Set(),
  rule: "A" | "B" = BRIDGE_ANCHOR_RULE,
): Promise<AnchorChoice> {
  const fallbackIds = anchorsForRule(candidates, seedTags, rule);
  const closed = closedAnchorList(candidates, seedTags);
  const fallback = (): AnchorChoice => ({
    ids: fallbackIds,
    source: "fallback",
    anchorSource: "rule_b_fallback",
    evidence: anchorEvidence(candidates, fallbackIds, seedTags),
    ms: 0,
  });
  if (!llmConfigured() || closed.length < 2) return fallback();
  const started = Date.now();
  try {
    const object = await readStructured(anchorPrompt(closed), anchorSchema, ANCHOR_TIMEOUT_MS);
    const ids = object.anchorIds;
    const valid =
      ids.length >= 2 &&
      ids.length <= 3 &&
      ids.every((id) => closed.some((anchor) => anchor.id === id)) &&
      new Set(ids.map((id) => closed.find((anchor) => anchor.id === id)!.slot)).size === ids.length;
    if (!valid) {
      return {
        ...fallback(),
        failure: anchorFailure(closed, ids),
        reason: object.reason || undefined,
        ms: Date.now() - started,
      };
    }
    return {
      ids,
      source: "llm",
      anchorSource: "llm",
      evidence: anchorEvidence(candidates, ids, seedTags),
      reason: object.reason || undefined,
      ms: Date.now() - started,
    };
  } catch (error) {
    return { ...fallback(), failure: failureClass(error), ms: Date.now() - started };
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

/** Tokens the LLM is allowed to use for one plan: only slots and anchors that exist. */
export function allowedTokens(plan: NarrativePlanInput): NarrativeToken[] {
  const tokens: NarrativeToken[] = [];
  for (const token of NARRATIVE_TOKENS) {
    if (token === "city") {
      if (plan.city.trim()) tokens.push(token);
      continue;
    }
    if (token.startsWith("anchor")) {
      const index = Number(token.slice("anchor".length)) - 1;
      if (plan.anchors[index]?.name?.trim()) tokens.push(token);
      continue;
    }
    if (plan.slots[token]?.trim()) tokens.push(token);
  }
  return tokens;
}

const TOKEN_PATTERN = /\[\[([^[\]]*)\]\]/g;

export function tokensIn(text: string): string[] {
  return [...text.matchAll(TOKEN_PATTERN)].map((match) => match[1] ?? "");
}

export function substituteTokens(text: string, plan: NarrativePlanInput): string {
  return text.replace(TOKEN_PATTERN, (whole, raw: string) => {
    if (raw === "city") return plan.city;
    if (raw.startsWith("anchor")) {
      const index = Number(raw.slice("anchor".length)) - 1;
      return plan.anchors[index]?.name ?? whole;
    }
    return plan.slots[raw as NarrativeToken] ?? whole;
  });
}

function sentenceCount(text: string): number {
  return text
    .split(/[.!?…]+/)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

const LANGUAGE_STOPWORDS: Record<Locale, string[]> = {
  en: ["the", "a", "an", "and", "with", "for", "from", "then", "into", "your", "night", "tonight", "start"],
  es: ["el", "la", "los", "las", "una", "un", "y", "con", "para", "de", "en", "tu", "noche", "esta", "desde"],
};

/**
 * Conservative: only rejects when the text looks like the other language and shows
 * no trace of the requested one, so a legitimate two-word line survives.
 */
export function wrongLanguage(text: string, locale: Locale): boolean {
  const other: Locale = locale === "es" ? "en" : "es";
  const words = text.toLowerCase().match(/[a-záéíóúñü]+/g) ?? [];
  const count = (list: string[]) => words.filter((word) => list.includes(word)).length;
  return count(LANGUAGE_STOPWORDS[locale]) === 0 && count(LANGUAGE_STOPWORDS[other]) > 0;
}

export function validateNarrative(
  text: string,
  plan: NarrativePlanInput,
  locale: Locale,
  maxChars: number,
): LlmFailure | null {
  if (!text.trim()) return "empty";
  if (text.length > maxChars) return "too_long";
  if (maxChars === MAX_NARRATIVE_CHARS && sentenceCount(text) > MAX_NARRATIVE_SENTENCES) {
    return "too_many_sentences";
  }
  if (/https?:\/\/|www\./i.test(text)) return "url";
  const allowed = new Set<string>(allowedTokens(plan));
  const seen = new Set<string>();
  for (const token of tokensIn(text)) {
    if (!allowed.has(token)) return "unknown_token";
    if (seen.has(token)) return "repeated_token";
    seen.add(token);
  }
  if (wrongLanguage(text, locale)) return "wrong_language";
  return null;
}

type NarrativeObject = {
  rootsNarrative?: string;
  rootsHeadline?: string;
  bridgeNarrative?: string;
  bridgeHeadline?: string;
};

function narrativeSchema(scope: "both" | "bridge"): z.ZodType<NarrativeObject> {
  if (scope === "bridge") {
    return z.object({
      bridgeNarrative: z.string(),
      bridgeHeadline: z.string(),
    });
  }
  return z.object({
    rootsNarrative: z.string(),
    rootsHeadline: z.string(),
    bridgeNarrative: z.string(),
    bridgeHeadline: z.string(),
  });
}

function narrativePrompt(
  locale: Locale,
  plans: NarrativePlanInput[],
  scope: "both" | "bridge",
  repair?: LlmFailure,
): string {
  const language = locale === "es" ? "Spanish" : "English";
  const lines = [
    `Write the connecting sentence for each plan, in ${language}.`,
    "Rules:",
    "- Never write an item name. Write the token instead, and use each token at most once per field.",
    `- Allowed tokens: ${NARRATIVE_TOKENS.map((token) => `[[${token}]]`).join(", ")}.`,
    "- Any other [[...]] token is rejected. No URLs.",
    `- Each narrative: at most ${MAX_NARRATIVE_SENTENCES} sentences and at most ${MAX_NARRATIVE_CHARS} characters.`,
    `- Each headline: at most ${MAX_HEADLINE_CHARS} characters, same token rules.`,
    "The server replaces every token with the real name from Qloo afterwards.",
    "Return JSON only.",
  ];
  if (repair) lines.push(`The previous attempt was rejected (${repair}). Fix exactly that and retry once.`);
  lines.push(`Plans: ${JSON.stringify(plans.map((plan) => ({ label: plan.label, city: plan.city, availableTokens: allowedTokens(plan) })))}`);
  lines.push(
    scope === "bridge"
      ? 'Return {"bridgeNarrative": "...", "bridgeHeadline": "..."}'
      : 'Return {"rootsNarrative": "...", "rootsHeadline": "...", "bridgeNarrative": "...", "bridgeHeadline": "..."}',
  );
  return lines.join("\n");
}

function templatePlan(plan: NarrativePlanInput, locale: Locale): PlanNarrative {
  const names = Object.values(plan.slots).filter((name): name is string => Boolean(name?.trim()));
  return {
    label: plan.label,
    text: templateNarrative(locale, names),
    headline: "",
    source: "template",
  };
}

/**
 * Names can never be wrong because the model never types one: it emits tokens and the
 * server substitutes the pack's own card names after validation.
 */
export async function composeNarratives(input: {
  locale: Locale;
  plans: NarrativePlanInput[];
  scope?: "both" | "bridge";
}): Promise<NarrativesChoice> {
  const scope = input.scope ?? (input.plans.some((plan) => plan.label === "A") ? "both" : "bridge");
  const state = llmModelState();
  const offReason = state.configured ? null : state.reason;
  const templates = new Map(input.plans.map((plan) => [plan.label, templatePlan(plan, input.locale)]));
  const failures: LlmFailure[] = [];
  if (!state.configured || input.plans.length === 0) {
    return { plans: [...templates.values()], provider: null, offReason, failures, ms: 0 };
  }
  const started = Date.now();
  const fields = scope === "bridge" ? (["bridge"] as const) : (["roots", "bridge"] as const);

  const attempt = async (repair?: LlmFailure): Promise<Map<string, PlanNarrative> | LlmFailure> => {
    const object = await readStructured<NarrativeObject>(
      narrativePrompt(input.locale, input.plans, scope, repair),
      narrativeSchema(scope),
      LLM_TIMEOUT_MS,
    );
    const out = new Map<string, PlanNarrative>();
    for (const side of fields) {
      const label = (side === "roots" ? "A" : "B") as "A" | "B";
      const plan = input.plans.find((entry) => entry.label === label);
      if (!plan) continue;
      const text = side === "roots" ? object.rootsNarrative : object.bridgeNarrative;
      const headline = side === "roots" ? object.rootsHeadline : object.bridgeHeadline;
      const failure =
        validateNarrative(text ?? "", plan, input.locale, MAX_NARRATIVE_CHARS) ??
        validateNarrative(headline ?? "", plan, input.locale, MAX_HEADLINE_CHARS);
      if (failure || text === undefined || headline === undefined) return failure ?? "empty";
      out.set(label, {
        label,
        text: substituteTokens(text, plan),
        headline: substituteTokens(headline, plan),
        source: "llm",
      });
    }
    return out;
  };

  let result: Map<string, PlanNarrative> | LlmFailure;
  try {
    result = await attempt();
    if (typeof result === "string") {
      failures.push(result);
      try {
        result = await attempt(result);
      } catch (error) {
        result = failureClass(error);
      }
      if (typeof result === "string") failures.push(result);
    }
  } catch (error) {
    result = failureClass(error);
    failures.push(result);
  }

  const plans = input.plans.map((plan) => {
    const llm = typeof result === "string" ? undefined : result.get(plan.label);
    return llm ?? templates.get(plan.label)!;
  });
  return { plans, provider: state.provider, offReason, failures, ms: Date.now() - started };
}

export async function narratePlan(input: {
  locale: Locale;
  plan: NarrativePlanInput;
}): Promise<PlanNarrative> {
  const choice = await composeNarratives({ locale: input.locale, plans: [input.plan], scope: "bridge" });
  return choice.plans[0]!;
}

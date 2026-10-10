import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export type LlmProviderId = "nebius" | "google";

/** Names and values are only ever read from the environment, never written back. */
export type LlmEnv = Record<string, string | undefined>;

export type LlmModelState =
  | { configured: true; provider: LlmProviderId; model: LanguageModel; modelId: string }
  | { configured: false; reason: string };

/** Variable names only. Values never leave this module. */
const REQUIRED: Record<LlmProviderId, readonly string[]> = {
  nebius: ["NEBIUS_API_KEY", "NEBIUS_BASE_URL", "NEBIUS_MODEL"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "LLM_MODEL"],
};

/**
 * `LLM_PROVIDER` selects the provider. Empty falls back to Nebius when its three
 * variables are set, so an existing `.env` keeps working unchanged.
 */
export function llmProviderId(env: LlmEnv = process.env): LlmProviderId | null {
  const declared = env.LLM_PROVIDER?.trim().toLowerCase();
  if (declared === "google" || declared === "nebius") return declared;
  if (declared) return null;
  return REQUIRED.nebius.every((name) => env[name]?.trim()) ? "nebius" : null;
}

function missingNames(provider: LlmProviderId, env: LlmEnv): string[] {
  return REQUIRED[provider].filter((name) => !env[name]?.trim());
}

/**
 * The AI SDK model for the configured provider, or a reason why the LLM is off.
 * Google has no default `LLM_MODEL`: without it the provider is off on purpose.
 */
export function llmModelState(env: LlmEnv = process.env): LlmModelState {
  const declared = env.LLM_PROVIDER?.trim().toLowerCase();
  const provider = llmProviderId(env);
  if (!provider) {
    if (declared) return { configured: false, reason: `unknown_provider:${declared}` };
    return { configured: false, reason: `missing:${REQUIRED.nebius.join(",")}` };
  }
  const missing = missingNames(provider, env);
  if (missing.length > 0) return { configured: false, reason: `missing:${missing.join(",")}` };
  if (provider === "google") {
    const modelId = env.LLM_MODEL!.trim();
    const google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
    return { configured: true, provider, modelId, model: google(modelId) };
  }
  const modelId = env.NEBIUS_MODEL!.trim();
  const nebius = createOpenAI({
    apiKey: env.NEBIUS_API_KEY,
    baseURL: env.NEBIUS_BASE_URL,
  });
  return { configured: true, provider, modelId, model: nebius(modelId) };
}

export function llmConfigured(env: LlmEnv = process.env): boolean {
  return llmModelState(env).configured;
}

export function llmOffReason(env: LlmEnv = process.env): string | null {
  const state = llmModelState(env);
  return state.configured ? null : state.reason;
}

/** Provider id when the LLM is on, plus the reason it is off when it is not. */
export function llmStatus(env: LlmEnv = process.env): {
  provider: LlmProviderId | null;
  offReason: string | null;
} {
  const state = llmModelState(env);
  return state.configured
    ? { provider: state.provider, offReason: null }
    : { provider: null, offReason: state.reason };
}

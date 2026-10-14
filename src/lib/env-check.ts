import { llmConfigured, llmOffReason } from "@/lib/llm/provider";

/** Minimum length accepted for SESSION_SECRET in production (HMAC key strength). */
export const SESSION_SECRET_MIN_LENGTH = 32;

let checked = false;

/**
 * Fail fast on a production misconfiguration. Messages name the variable only —
 * never a value — so the error is safe to surface in logs.
 */
export function checkBootEnv(): void {
  if (checked || process.env.NEXT_PHASE === "phase-production-build") return;
  checked = true;
  if (process.env.NODE_ENV === "production") {
    if (!process.env.DATABASE_URL?.trim()) {
      throw new Error("DATABASE_URL is required in production");
    }
    const secret = process.env.SESSION_SECRET?.trim();
    if (!secret) {
      throw new Error("SESSION_SECRET is required in production");
    }
    if (secret.length < SESSION_SECRET_MIN_LENGTH) {
      throw new Error(
        `SESSION_SECRET must be at least ${SESSION_SECRET_MIN_LENGTH} characters in production`,
      );
    }
  }
  if (!process.env.QLOO_API_KEY?.trim()) {
    console.warn("QLOO_API_KEY is empty; live Qloo calls are off.");
  }
  if (!llmConfigured()) {
    console.warn(`LLM is off (${llmOffReason()}); narration stays on the template.`);
  }
}

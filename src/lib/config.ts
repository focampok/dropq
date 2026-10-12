/**
 * Abuse, quota and cache knobs. Values may also come from env (names in `.env.example`).
 * In-memory counters assume a single app instance.
 */

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** Block all live Qloo calls below this remaining monthly count. */
export const QLOO_HARD_RESERVE = 800;

/** Below this, refuse custom (non-preset, non-cached) generations; presets and cache still work. */
export const QLOO_CUSTOM_RESERVE = intEnv("QLOO_CUSTOM_RESERVE", 2000);

/** Global soft cap on live (uncached) pack generations per rolling day. */
export const LIVE_GENERATIONS_PER_DAY = intEnv("LIVE_GENERATIONS_PER_DAY", 250);

/** Skip the LLM (rule B + template) above this many Gemini calls per rolling hour. */
export const LLM_CALLS_PER_HOUR = intEnv("LLM_CALLS_PER_HOUR", 120);

/** Trusted proxy hops for X-Forwarded-For (take the Nth entry from the right). */
export const TRUSTED_PROXY_HOPS = intEnv("TRUSTED_PROXY_HOPS", 1);

/** Max JSON request body size for user-input routes. */
export const MAX_BODY_BYTES = 10 * 1024;

/** Pack cache TTL for ordinary requests (hours). */
export const PACK_CACHE_TTL_HOURS = intEnv("PACK_CACHE_TTL_HOURS", 24);

/** Pack cache TTL for preset warm entries (hours). */
export const PACK_CACHE_PRESET_TTL_HOURS = 72;

/** Uncached pack generations per session cookie. */
export const PACK_SESSION_LIMITS = [
  { ms: 10 * 60_000, max: 6 },
  { ms: 24 * 60 * 60_000, max: 20 },
] as const;

/** Uncached pack generations per client IP. */
export const PACK_IP_LIMITS = [
  { ms: 10 * 60_000, max: 20 },
  { ms: 24 * 60 * 60_000, max: 60 },
] as const;

/** Loose limit for cache hits and Deep cuts toggles. */
export const CHEAP_IP_LIMIT = { ms: 60_000, max: 60 } as const;

/**
 * Per-attempt abort caps as a fraction of the call deadline. Anchors (6 s) → 3 s;
 * narration (12 s) → 6 s. The chain uses `min(remaining, deadline * fraction)`.
 */
export const GEMINI_ATTEMPT_CAP_FRACTION_ANCHORS = 0.5;
export const GEMINI_ATTEMPT_CAP_FRACTION_NARRATION = 0.5;

/** Soft-demote a slow model for this long (in-memory only; not a quota cooldown). */
export const GEMINI_SLOW_DEMOTION_MS = 10 * 60_000;

/** Latency above this fraction of the per-attempt cap counts as slow (two in a row demotes). */
export const GEMINI_SLOW_LATENCY_FRACTION = 0.8;

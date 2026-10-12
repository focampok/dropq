/**
 * Gemini transport: model list, error classes and the fallback loop.
 * The algorithm follows the proven chain (sticky preferred model, permanent
 * discard, transient backoff). DropQ adds one limit the original loop does
 * not have: a wall-clock deadline, because the anchor call sits before first paint.
 */

import { noteLlmHourlyCall } from "@/lib/rate-limit";

export const TRANSIENT_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);

const TRANSIENT_MESSAGE =
  /error fetching from|fetch failed|network|timeout|abort|econnrefused|socket hang up/i;

/** Lowest thinkingLevel the installed @ai-sdk/google provider accepts. */
export const GEMINI_THINKING_LEVEL = "minimal" as const;

export type GeminiOff = "no_key" | "no_model";

/** Gemini free-tier daily quotas reset at midnight America/Los_Angeles. */
export const GEMINI_DAILY_QUOTA_TZ = "America/Los_Angeles";

export type RateLimitKind = "per_day" | "per_minute" | "unknown";

export type GeminiConfig = {
  apiKey: string;
  models: string[];
  retryAttempts: number;
  retryDelayMs: number;
  retryMaxDelayMs: number;
};

export type LlmCallTrace = {
  modelUsed: string | null;
  attempts: number;
  chainTried: string[];
  latencyMs: number;
  calls: number;
};

export type ChainCall = {
  modelId: string;
  abortSignal: AbortSignal;
  thinking: boolean;
};

export type ChainHooks = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type Env = Record<string, string | undefined>;

/** `Number(env) || default`, so 0, empty and NaN use the default. */
export function envNumber(value: string | undefined, fallback: number): number {
  return Number(value) || fallback;
}

export function readGeminiConfig(env: Env = process.env): { ok: true; config: GeminiConfig } | { ok: false; off: GeminiOff } {
  const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || env.GEMINI_API_KEY?.trim() || "";
  if (!apiKey) return { ok: false, off: "no_key" };
  const principal = env.GEMINI_MODEL?.trim() || env.LLM_MODEL?.trim() || "";
  if (!principal) return { ok: false, off: "no_model" };
  const fallbacks = (env.GEMINI_FALLBACK_MODELS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model.length > 0 && model !== principal);
  return {
    ok: true,
    config: {
      apiKey,
      models: [principal, ...fallbacks],
      retryAttempts: Math.max(1, envNumber(env.GEMINI_RETRY_ATTEMPTS, 3)),
      retryDelayMs: envNumber(env.GEMINI_RETRY_DELAY_MS, 1000),
      retryMaxDelayMs: envNumber(env.GEMINI_RETRY_MAX_DELAY_MS, 8000),
    },
  };
}

export class GeminiDeadlineError extends Error {
  readonly cause: unknown;
  constructor(cause?: unknown) {
    super("deadline");
    this.name = "GeminiDeadlineError";
    this.cause = cause;
  }
}

export class GeminiBudgetError extends Error {
  constructor() {
    super("llm_budget");
    this.name = "GeminiBudgetError";
  }
}

/** Every model in the chain is in a quota cooldown; callers fall back immediately. */
export class GeminiQuotaError extends Error {
  readonly kind: "per_day" | "per_minute";
  constructor(kind: "per_day" | "per_minute") {
    super(kind === "per_day" ? "quota_daily" : "quota_minute");
    this.name = "GeminiQuotaError";
    this.kind = kind;
  }
}

const PER_MINUTE_DEFAULT_MS = 60_000;
const PER_MINUTE_CAP_MS = 10 * 60_000;

/**
 * Inspect a 429 in memory only. Never log the body: callers may read the
 * returned kind and delay, nothing else.
 */
export function classifyRateLimit(error: unknown): { kind: RateLimitKind; retryDelayMs: number | null } {
  const blobs: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string") blobs.push(value);
    else if (value && typeof value === "object") {
      try {
        blobs.push(JSON.stringify(value));
      } catch {
        /* ignore */
      }
    }
  };
  if (error instanceof Error) push(error.message);
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["data", "responseBody", "cause", "message", "url"]) push(record[key]);
  }
  const joined = blobs.join("\n");
  const hasPerDay = /PerDay|per[\s_-]?day|GenerateRequestsPerDay|RequestsPerDay/i.test(joined);
  let retryDelayMs: number | null = null;
  const delayMatch = joined.match(/retryDelay["'\s:]*([0-9.]+)s/i);
  const afterMatch = joined.match(/retry[_-]?after["'\s:]*([0-9.]+)/i);
  if (delayMatch) retryDelayMs = Math.round(Number(delayMatch[1]) * 1000);
  else if (afterMatch) {
    const raw = Number(afterMatch[1]);
    retryDelayMs = Math.round(raw > 1000 ? raw : raw * 1000);
  }
  if (hasPerDay) return { kind: "per_day", retryDelayMs };
  if (retryDelayMs != null) return { kind: "per_minute", retryDelayMs };
  return { kind: "unknown", retryDelayMs: null };
}

/** Next midnight in {@link GEMINI_DAILY_QUOTA_TZ}, as a UTC epoch ms. */
export function nextPacificMidnightMs(nowMs: number): number {
  const dayFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: GEMINI_DAILY_QUOTA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = dayFmt.format(new Date(nowMs));
  let lo = nowMs;
  let hi = nowMs + 36 * 3600_000;
  while (hi - lo > 250) {
    const mid = Math.floor((lo + hi) / 2);
    if (dayFmt.format(new Date(mid)) === today) lo = mid;
    else hi = mid;
  }
  return hi;
}

function cooldownMsFor(kind: RateLimitKind, retryDelayMs: number | null, nowMs: number): number {
  if (kind === "per_day") return Math.max(0, nextPacificMidnightMs(nowMs) - nowMs);
  const suggested = retryDelayMs != null && Number.isFinite(retryDelayMs) ? retryDelayMs : PER_MINUTE_DEFAULT_MS;
  return Math.min(Math.max(suggested, 0), PER_MINUTE_CAP_MS);
}

let geminiCalls = 0;

export function geminiCallCount(): number {
  return geminiCalls;
}

export function resetGeminiCallCount(): void {
  geminiCalls = 0;
}

/** Throws before the call that would pass the process budget. Unset means no cap. */
export function noteGeminiCall(): void {
  const raw = process.env.DROPQ_LLM_BUDGET;
  const budget = raw === undefined || raw.trim() === "" ? Infinity : Number(raw);
  const cap = Number.isFinite(budget) && budget > 0 ? budget : Infinity;
  if (geminiCalls + 1 > cap) throw new GeminiBudgetError();
  geminiCalls += 1;
  // Soft hourly cap is enforced before callers enter the LLM; this only records.
  noteLlmHourlyCall();
}

/** The installed `ai` package names this class `AI_APICallError` and puts the HTTP status on `statusCode`. */
function isApiCallError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AI_APICallError" || error.name === "APICallError");
}

function statusCodeOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { statusCode?: unknown; status?: unknown };
  if (typeof record.statusCode === "number") return record.statusCode;
  if (typeof record.status === "number") return record.status;
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

export function isParseError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  const name = error instanceof Error ? error.name : "";
  return (
    name.includes("NoObjectGenerated") ||
    name.includes("TypeValidation") ||
    name.includes("JSONParse") ||
    name.includes("Zod")
  );
}

/** Transient: 429 and 5xx, no HTTP status, or a transport message. Everything else is permanent. */
export function isTransient(error: unknown): boolean {
  if (
    error instanceof GeminiDeadlineError ||
    error instanceof GeminiBudgetError ||
    error instanceof GeminiQuotaError ||
    isParseError(error)
  ) {
    return false;
  }
  const status = statusCodeOf(error);
  if (status != null) return TRANSIENT_HTTP_STATUS.has(status);
  if (isApiCallError(error)) return true;
  if (TRANSIENT_MESSAGE.test(messageOf(error))) return true;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError" || error.name === "TypeError")) {
    return true;
  }
  return false;
}

export function isThinkingRejection(error: unknown): boolean {
  const status = statusCodeOf(error);
  return status === 400 && /thinking/i.test(messageOf(error));
}

export type GeminiFailureCode =
  | "rate_limited"
  | "quota_daily"
  | "quota_minute"
  | "model_unavailable"
  | "auth"
  | "server_error"
  | "network"
  | "deadline";

export function geminiFailureCode(error: unknown): GeminiFailureCode | null {
  if (error instanceof GeminiDeadlineError) return "deadline";
  if (error instanceof GeminiQuotaError) return error.kind === "per_day" ? "quota_daily" : "quota_minute";
  const status = statusCodeOf(error);
  if (status === 429) return "rate_limited";
  if (status === 404) return "model_unavailable";
  if (status === 401 || status === 403) return "auth";
  if (status != null && status >= 500 && status <= 599) return "server_error";
  if (status == null && isTransient(error)) return "network";
  return null;
}

export function emptyTrace(): LlmCallTrace {
  return { modelUsed: null, attempts: 0, chainTried: [], latencyMs: 0, calls: 0 };
}

export function mergeTrace(left: LlmCallTrace | null | undefined, right: LlmCallTrace | null | undefined): LlmCallTrace {
  const a = left ?? emptyTrace();
  const b = right ?? emptyTrace();
  return {
    modelUsed: b.modelUsed ?? a.modelUsed,
    attempts: a.attempts + b.attempts,
    chainTried: [...a.chainTried, ...b.chainTried],
    latencyMs: a.latencyMs + b.latencyMs,
    calls: a.calls + b.calls,
  };
}

const TRACE = Symbol("geminiTrace");

export function attachTrace(error: unknown, trace: LlmCallTrace): unknown {
  if (error && typeof error === "object") {
    Object.defineProperty(error, TRACE, { value: trace, enumerable: false });
  }
  return error;
}

export function readTrace(error: unknown): LlmCallTrace | null {
  if (!error || typeof error !== "object") return null;
  const trace = (error as { [TRACE]?: LlmCallTrace })[TRACE];
  return trace ?? null;
}

export type ChainSuccess<T> = {
  value: T;
  trace: LlmCallTrace;
};

/**
 * One chain per process. `modeloPreferidoIdx` sticks to the model that just
 * succeeded. Models are not cached: the caller builds one per attempt.
 * Quota 429s put a model in an in-memory cooldown so the next call skips it
 * immediately instead of burning the deadline on retries that cannot succeed.
 */
export class GeminiChain {
  modeloPreferidoIdx = 0;
  private readonly thinkingOff = new Set<string>();
  /** modelId → epoch ms when the cooldown ends. */
  private readonly cooldownUntil = new Map<string, number>();
  /** modelId → last classified quota kind that set the cooldown. */
  private readonly cooldownKind = new Map<string, RateLimitKind>();

  constructor(
    readonly config: GeminiConfig,
    private readonly hooks: ChainHooks = {},
  ) {}

  private now(): number {
    return this.hooks.now ? this.hooks.now() : Date.now();
  }

  private sleep(ms: number): Promise<void> {
    if (this.hooks.sleep) return this.hooks.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** True while every configured model is still in a quota cooldown. */
  quotaBlocked(): "per_day" | "per_minute" | null {
    const now = this.now();
    const modelos = this.config.models;
    if (modelos.length === 0) return null;
    if (!modelos.every((id) => (this.cooldownUntil.get(id) ?? 0) > now)) return null;
    return this.dominantCooldownKind(now);
  }

  private dominantCooldownKind(now: number): "per_day" | "per_minute" {
    let anyDay = false;
    for (const id of this.config.models) {
      if ((this.cooldownUntil.get(id) ?? 0) > now && this.cooldownKind.get(id) === "per_day") anyDay = true;
    }
    return anyDay ? "per_day" : "per_minute";
  }

  private inCooldown(modelId: string, now: number): boolean {
    return (this.cooldownUntil.get(modelId) ?? 0) > now;
  }

  private applyQuotaCooldown(modelId: string, error: unknown): RateLimitKind {
    const { kind, retryDelayMs } = classifyRateLimit(error);
    const now = this.now();
    const ms = cooldownMsFor(kind, retryDelayMs, now);
    this.cooldownUntil.set(modelId, now + ms);
    this.cooldownKind.set(modelId, kind);
    return kind;
  }

  async generate<T>(deadlineMs: number, run: (call: ChainCall) => Promise<T>): Promise<ChainSuccess<T>> {
    const started = this.now();
    const deadlineAt = started + deadlineMs;
    const modelos = this.config.models;
    const intentosMaximos = Math.max(1, this.config.retryAttempts);
    const presupuesto = intentosMaximos * Math.max(1, modelos.length);
    const descartados = new Set<number>();
    let intentosGlobales = 0;
    let ultimoError: unknown = new Error("no_attempt");
    const chainTried: string[] = [];
    let calls = 0;

    const trace = (modelUsed: string | null): LlmCallTrace => ({
      modelUsed,
      attempts: intentosGlobales,
      chainTried: [...chainTried],
      latencyMs: this.now() - started,
      calls,
    });

    const fail = (error: unknown, modelUsed: string | null = null): never => {
      attachTrace(error, trace(modelUsed));
      throw error;
    };

    const blocked = this.quotaBlocked();
    if (blocked) return fail(new GeminiQuotaError(blocked));

    const pick = (): number | null => {
      if (modelos.length === 0) return null;
      const now = this.now();
      for (let step = 0; step < modelos.length; step += 1) {
        const idx = (this.modeloPreferidoIdx + step) % modelos.length;
        if (descartados.has(idx)) continue;
        if (this.inCooldown(modelos[idx]!, now)) {
          descartados.add(idx);
          continue;
        }
        return idx;
      }
      return null;
    };

    while (intentosGlobales < presupuesto) {
      if (this.now() >= deadlineAt) return fail(new GeminiDeadlineError(ultimoError));
      const idx = pick();
      if (idx === null) {
        // Only a quota exhaustion path: every model still in cooldown (not merely discarded).
        if (modelos.every((id) => this.inCooldown(id, this.now()))) {
          return fail(new GeminiQuotaError(this.dominantCooldownKind(this.now())));
        }
        break;
      }
      const modelId = modelos[idx]!;
      const remaining = deadlineAt - this.now();
      const thinking = !this.thinkingOff.has(modelId);
      chainTried.push(modelId);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(0, remaining));
      try {
        noteGeminiCall();
        calls += 1;
        const value = await run({ modelId, abortSignal: controller.signal, thinking });
        this.modeloPreferidoIdx = idx;
        return { value, trace: trace(modelId) };
      } catch (error) {
        if (error instanceof GeminiBudgetError) return fail(error);
        if (isParseError(error)) {
          this.modeloPreferidoIdx = idx;
          return fail(error, null);
        }
        ultimoError = error;
        intentosGlobales += 1;
        const abortedByDeadline = controller.signal.aborted && this.now() >= deadlineAt;
        if (abortedByDeadline) return fail(new GeminiDeadlineError(error));
        if (thinking && isThinkingRejection(error)) {
          this.thinkingOff.add(modelId);
          continue;
        }
        // Quota 429: set cooldown, discard for this call, skip immediately (no sleep).
        if (statusCodeOf(error) === 429) {
          this.applyQuotaCooldown(modelId, error);
          descartados.add(idx);
          this.modeloPreferidoIdx = nextLive(modelos.length, idx, descartados);
          continue;
        }
        if (!isTransient(error)) {
          descartados.add(idx);
          if (this.modeloPreferidoIdx === idx) {
            this.modeloPreferidoIdx = (this.modeloPreferidoIdx + 1) % Math.max(1, modelos.length);
          }
          continue;
        }
        const exponent = Math.min(intentosGlobales - 1, 5);
        const delay = Math.min(this.config.retryDelayMs * 2 ** exponent, this.config.retryMaxDelayMs);
        this.modeloPreferidoIdx = nextLive(modelos.length, idx, descartados);
        if (this.now() + delay > deadlineAt) return fail(ultimoError);
        await this.sleep(delay);
      } finally {
        clearTimeout(timer);
      }
    }
    const quotaKind = this.quotaBlocked();
    if (quotaKind) return fail(new GeminiQuotaError(quotaKind));
    return fail(ultimoError);
  }
}

function nextLive(length: number, fromIdx: number, discarded: Set<number>): number {
  if (length === 0) return 0;
  for (let step = 1; step <= length; step += 1) {
    const idx = (fromIdx + step) % length;
    if (!discarded.has(idx)) return idx;
  }
  return (fromIdx + 1) % length;
}

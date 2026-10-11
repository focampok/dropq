import { NextResponse } from "next/server";
import {
  CHEAP_IP_LIMIT,
  LIVE_GENERATIONS_PER_DAY,
  LLM_CALLS_PER_HOUR,
  PACK_IP_LIMITS,
  PACK_SESSION_LIMITS,
  TRUSTED_PROXY_HOPS,
} from "@/lib/config";
import { sessionCookie } from "@/lib/session/cookie";

type WindowRule = { ms: number; max: number };

const buckets = new Map<string, number[]>();
let liveDayStamps: number[] = [];
let llmHourStamps: number[] = [];
let lastCleanup = 0;

function cleanup(now: number): void {
  if (now - lastCleanup < 60_000) return;
  lastCleanup = now;
  for (const [key, stamps] of buckets) {
    const kept = stamps.filter((stamp) => now - stamp < 24 * 60 * 60_000);
    if (kept.length === 0) buckets.delete(key);
    else buckets.set(key, kept);
  }
  liveDayStamps = liveDayStamps.filter((stamp) => now - stamp < 24 * 60 * 60_000);
  llmHourStamps = llmHourStamps.filter((stamp) => now - stamp < 60 * 60_000);
}

function take(key: string, rule: WindowRule, now: number): { ok: true } | { ok: false; retryAfterSec: number } {
  const stamps = (buckets.get(key) ?? []).filter((stamp) => now - stamp < rule.ms);
  if (stamps.length >= rule.max) {
    buckets.set(key, stamps);
    const oldest = stamps[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((rule.ms - (now - oldest)) / 1000));
    return { ok: false, retryAfterSec };
  }
  stamps.push(now);
  buckets.set(key, stamps);
  return { ok: true };
}

/**
 * Client IP: take the Nth entry from the right of X-Forwarded-For (N = TRUSTED_PROXY_HOPS).
 * Never trust the leftmost entry alone — that is attacker-controlled.
 */
export function clientIp(request: Request, hops = TRUSTED_PROXY_HOPS): string {
  const raw = request.headers.get("x-forwarded-for");
  if (!raw?.trim()) return "local";
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return "local";
  const index = Math.max(0, parts.length - Math.max(1, hops));
  return parts[index] || "local";
}

function sessionKey(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${sessionCookie.name}=([^;]+)`));
  return match?.[1] ? `session:${match[1]}` : null;
}

function rateLimited(retryAfterSec: number): NextResponse {
  return NextResponse.json(
    { error: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

export type RateScope = "pack_live" | "pack_cheap" | "other";

/**
 * Enforce in-memory rate limits. `pack_live` is for uncached generations;
 * `pack_cheap` for cache hits and Deep cuts; `other` for seeds/resolve/session.
 */
export function enforceRateLimit(request: Request, scope: RateScope): NextResponse | null {
  const now = Date.now();
  cleanup(now);
  const ip = clientIp(request);

  if (scope === "pack_cheap" || scope === "other") {
    const result = take(`cheap:${ip}`, CHEAP_IP_LIMIT, now);
    if (!result.ok) return rateLimited(result.retryAfterSec);
    return null;
  }

  // pack_live: session + IP windows
  const session = sessionKey(request);
  if (session) {
    for (const rule of PACK_SESSION_LIMITS) {
      const result = take(`${session}:${rule.ms}`, rule, now);
      if (!result.ok) return rateLimited(result.retryAfterSec);
    }
  }
  for (const rule of PACK_IP_LIMITS) {
    const result = take(`ip:${ip}:${rule.ms}`, rule, now);
    if (!result.ok) return rateLimited(result.retryAfterSec);
  }
  return null;
}

/** Soft global cap on live generations; caller refuses with the demo-resting message. */
export function liveGenerationAllowed(): boolean {
  const now = Date.now();
  cleanup(now);
  liveDayStamps = liveDayStamps.filter((stamp) => now - stamp < 24 * 60 * 60_000);
  return liveDayStamps.length < LIVE_GENERATIONS_PER_DAY;
}

export function noteLiveGeneration(): void {
  liveDayStamps.push(Date.now());
}

/** Soft global Gemini hourly cap. */
export function llmHourlyAllowed(): boolean {
  const now = Date.now();
  cleanup(now);
  llmHourStamps = llmHourStamps.filter((stamp) => now - stamp < 60 * 60_000);
  return llmHourStamps.length < LLM_CALLS_PER_HOUR;
}

export function noteLlmHourlyCall(): void {
  llmHourStamps.push(Date.now());
}

export function resetRateLimits(): void {
  buckets.clear();
  liveDayStamps = [];
  llmHourStamps = [];
  lastCleanup = 0;
}

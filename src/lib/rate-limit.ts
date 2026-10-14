import { NextResponse } from "next/server";
import {
  CHEAP_IP_LIMIT,
  LIVE_GENERATIONS_PER_DAY,
  LLM_CALLS_PER_HOUR,
  PACK_IP_LIMITS,
  PACK_SESSION_LIMITS,
  TRUSTED_PROXY_HOPS,
  logIpProbeEnabled,
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
 * Bucket for a request whose client address could not be derived. Every such
 * request shares it, so a wrong `TRUSTED_PROXY_HOPS` shows up as callers
 * competing for one budget rather than as a bypass.
 */
export const UNKNOWN_IP = "unknown";

/**
 * Client address from `X-Forwarded-For`.
 *
 * A proxy *appends* the address of the peer it received the connection from, so
 * the list reads left-to-right as "furthest upstream first". Entries to the left
 * of the last `hops` ones were written by the client or by an untrusted hop and
 * are attacker-controlled. With `hops` trusted proxies the address the nearest
 * trusted proxy actually observed is the `hops`-th entry from the right — so
 * with the usual single proxy (`TRUSTED_PROXY_HOPS=1`) the client is the
 * **last** entry. That is the only position we ever read.
 *
 * `hops = 0` means no trusted proxy wrote the header, so nothing in it can be
 * attributed: the request lands in the shared unknown bucket rather than being
 * keyed on a value the caller chose.
 *
 * A missing, empty or whitespace-only header is also unknown, and an entry that
 * is not a usable address (empty segment, junk) collapses to unknown rather than
 * starting a bucket per junk value.
 */
export function clientIp(request: Request, hops = TRUSTED_PROXY_HOPS): string {
  if (hops < 1) return UNKNOWN_IP;
  const raw = request.headers.get("x-forwarded-for");
  if (!raw?.trim()) return UNKNOWN_IP;
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return UNKNOWN_IP;
  const index = Math.max(0, parts.length - hops);
  const value = parts[index];
  return value ? value : UNKNOWN_IP;
}

/**
 * True for an address in a private, loopback, link-local or CGNAT range:
 * 10/8, 172.16/12, 192.168/16, 100.64/10, 127/8, fc00::/7, ::1.
 * Used only by the IP probe below.
 */
export function isPrivateAddress(ip: string): boolean {
  if (!ip || ip === UNKNOWN_IP) return false;

  const mapped = ip.toLowerCase().match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]!);

  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  const firstGroup = lower.split(":")[0] ?? "";
  if (!/^[0-9a-f]{1,4}$/.test(firstGroup)) return false;
  const value = Number.parseInt(firstGroup, 16);
  // fc00::/7 spans fc00 through fdff.
  return value >= 0xfc00 && value <= 0xfdff;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** How many requests the temporary IP probe reports before going quiet. */
const IP_PROBE_REQUESTS = 5;
let ipProbeRemaining = IP_PROBE_REQUESTS;

/** Test seam: the probe budget is process-wide and would leak between cases. */
export function resetIpProbe(): void {
  ipProbeRemaining = IP_PROBE_REQUESTS;
}

/**
 * Temporary diagnostic for verifying `TRUSTED_PROXY_HOPS` in production, off
 * unless `LOG_IP_PROBE` is on. Reports only counts and a boolean — never an
 * address — so the log can be pasted anywhere. `derived_private=true` from a
 * real visitor means the hop count is wrong and everyone is sharing one bucket.
 */
function logIpProbe(request: Request, hops: number): void {
  if (!logIpProbeEnabled() || ipProbeRemaining <= 0) return;
  ipProbeRemaining -= 1;
  const raw = request.headers.get("x-forwarded-for") ?? "";
  const entries = raw.split(",").map((part) => part.trim()).filter(Boolean).length;
  console.log(
    `ip_probe xff_entries=${entries} hops=${hops} derived_private=${isPrivateAddress(clientIp(request, hops))}`,
  );
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
  logIpProbe(request, TRUSTED_PROXY_HOPS);
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

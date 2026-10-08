import { jsonError } from "@/lib/http";

type WindowRule = { ms: number; max: number };

const buckets = new Map<string, number[]>();

function rulesFor(scope: "pack" | "other"): WindowRule[] {
  if (scope === "pack") return [
    { ms: 60_000, max: 4 },
    { ms: 3_600_000, max: 20 },
  ];
  return [{ ms: 60_000, max: 60 }];
}

export function enforceRateLimit(request: Request, scope: "pack" | "other") {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  for (const rule of rulesFor(scope)) {
    const key = `${scope}:${rule.ms}:${ip}`;
    const stamps = (buckets.get(key) ?? []).filter((stamp) => now - stamp < rule.ms);
    if (stamps.length >= rule.max) {
      buckets.set(key, stamps);
      return jsonError("rate_limited", 429);
    }
    stamps.push(now);
    buckets.set(key, stamps);
  }
  return null;
}

export function resetRateLimits(): void {
  buckets.clear();
}

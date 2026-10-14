import { NextResponse } from "next/server";
import { QLOO_CUSTOM_RESERVE } from "@/lib/config";
import { liveGenerationAllowed, noteLiveGeneration } from "@/lib/rate-limit";
import { qlooQuota } from "@/lib/qloo/client";
import { qlooApiKey, qlooMocksAllowed } from "@/lib/qloo/config";
import { matchesPresetSeeds } from "@/lib/presets";

export const demoRestingBody = {
  error: "DEMO_RESTING",
  en: "The live demo is resting — try a preset pack instead.",
  es: "La demo en vivo está descansando; prueba un preset.",
};

export function demoRestingResponse(): NextResponse {
  return NextResponse.json(demoRestingBody, { status: 503 });
}

/** True when the session seeds match a known demo preset. */
export function isPresetSession(seeds: { rawText: string }[]): boolean {
  return matchesPresetSeeds(seeds.map((seed) => seed.rawText));
}

/**
 * Refuse live generations that must not run. Cached hits never reach this.
 * In production without a Qloo key, every live build is refused (no mock path).
 * Otherwise only custom (non-preset) builds are refused on reserve / daily cap.
 */
export function refuseCustomLive(seeds: { rawText: string }[]): NextResponse | null {
  if (!qlooApiKey() && !qlooMocksAllowed()) {
    return demoRestingResponse();
  }
  if (isPresetSession(seeds)) return null;
  const quota = qlooQuota();
  if (quota.remaining !== undefined && quota.remaining < QLOO_CUSTOM_RESERVE) {
    return demoRestingResponse();
  }
  if (!liveGenerationAllowed()) return demoRestingResponse();
  return null;
}

export function markLiveGeneration(seeds: { rawText: string }[]): void {
  if (!isPresetSession(seeds)) noteLiveGeneration();
}

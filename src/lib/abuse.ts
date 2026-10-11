import { NextResponse } from "next/server";
import { QLOO_CUSTOM_RESERVE } from "@/lib/config";
import { liveGenerationAllowed, noteLiveGeneration } from "@/lib/rate-limit";
import { qlooQuota } from "@/lib/qloo/client";
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
 * Refuse custom live generations when the monthly reserve or the daily soft cap is hit.
 * Cached packs and presets keep working (caller skips this check for those).
 */
export function refuseCustomLive(seeds: { rawText: string }[]): NextResponse | null {
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

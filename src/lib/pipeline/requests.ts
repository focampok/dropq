import type { InsightsParams, InsightEntityType } from "@/lib/qloo/types";
import {
  BRIDGE_VARIANT,
  DEEP_CUTS_POPULARITY_MAX,
  PLACE_CATEGORY_TAGS,
  PLACE_POINTS,
  PLACE_RADIUS_METERS,
  PLACE_STRATEGY,
  PLACE_USE_ANCHORS,
  USE_EXPLAINABILITY,
  type PlaceCity,
} from "@/lib/pipeline/config";

export const PACK_SLOTS = ["watch", "listen", "wear", "do"] as const;
export type PackSlot = (typeof PACK_SLOTS)[number];
export type BridgeRequestVariant = "a" | "b" | "c" | "deep";
export type PlaceMode = "anchors" | "city";

/**
 * Place gets a wider window than the other slots because Roots ids are removed
 * client-side (filter.exclude.entities is not sent for place), so 10 hits leave
 * no headroom when the city list overlaps the Roots list.
 */
const PLACE_TAKE = 20;

export function watchType(): InsightEntityType {
  return "urn:entity:tv_show";
}

export function slotType(slot: PackSlot): InsightEntityType {
  if (slot === "watch") return watchType();
  if (slot === "listen") return "urn:entity:artist";
  if (slot === "wear") return "urn:entity:brand";
  return "urn:entity:place";
}

export function placeCategoryTags(eventKind: string): string[] | null {
  if (eventKind !== "tour" && eventKind !== "con" && eventKind !== "comunidad") return null;
  const tags = PLACE_CATEGORY_TAGS[eventKind];
  return tags && tags.length > 0 ? [...tags] : null;
}

export function insightArgs(input: {
  slot: PackSlot;
  eventKind: string;
  anchors: string[];
  city: string;
  hop: 0 | 1;
  exclude: string[];
  filterType?: InsightEntityType;
  bridgeVariant?: BridgeRequestVariant;
  placeMode?: PlaceMode;
  placeRadius?: number;
}): InsightsParams | null {
  const filterType = input.filterType ?? slotType(input.slot);
  const placeMode = input.placeMode ?? (PLACE_USE_ANCHORS ? "anchors" : "city");
  if (input.slot !== "do" && input.anchors.length === 0) return null;

  const args: InsightsParams = {
    filterType,
    take: input.slot === "do" ? PLACE_TAKE : 10,
    explainability: input.hop === 0 && USE_EXPLAINABILITY,
    // Place does not take filter.exclude.entities: Roots ids are dropped client-side
    // instead (see pipeline/place.ts), which keeps the slot filled deterministically.
    ...(input.slot === "do" ? {} : { filterExcludeEntities: input.exclude }),
  };

  if (input.slot !== "do") {
    args.signalInterestsEntities = input.anchors;
  }

  if (input.hop === 1 && input.slot !== "do") {
    args.signalLocationQuery = input.city;
    const variant = input.bridgeVariant ?? BRIDGE_VARIANT;
    if (variant === "b") args.biasTrends = "high";
    if (variant === "c") args.filterPopularityMax = 0.98;
    if (variant === "deep") args.filterPopularityMax = DEEP_CUTS_POPULARITY_MAX;
  }

  if (input.slot === "do") {
    if (PLACE_STRATEGY === "none") return null;
    const tags = placeCategoryTags(input.eventKind);
    if (tags) args.filterTags = tags;
    if (placeMode === "anchors") {
      if (input.anchors.length === 0) return null;
      args.signalInterestsEntities = input.anchors;
    }
    const point = PLACE_POINTS[input.city as PlaceCity];
    if (PLACE_STRATEGY === "s1") args.signalLocationQuery = input.city;
    if (PLACE_STRATEGY === "s2") {
      args.filterGeocodeName = input.city;
      args.filterGeocodeCountryCode = "US";
    }
    if (PLACE_STRATEGY === "s3") {
      if (!point) return null;
      args.filterLocation = `POINT(${point.lon} ${point.lat})`;
      args.filterLocationRadius = input.placeRadius ?? PLACE_RADIUS_METERS;
    }
  }
  return args;
}

export function locationKey(args: InsightsParams): string {
  return [
    args.signalLocationQuery ?? "",
    args.filterGeocodeName ?? "",
    args.filterLocation ?? "",
    args.filterLocationRadius ?? "",
    args.biasTrends ?? "",
    args.filterPopularityMax ?? "",
    (args.filterTags ?? []).join(","),
    (args.signalInterestsEntities ?? []).join(","),
  ].join("|");
}

export function validNamedHit(hit: { entityId: string; name: string }): boolean {
  return Boolean(hit.entityId.trim() && hit.name.trim());
}

export async function loadWatchHits<T extends { entityId: string; name: string }>(
  load: (type: "urn:entity:tv_show" | "urn:entity:movie") => Promise<T[]>,
): Promise<T[]> {
  const shows = (await load("urn:entity:tv_show")).filter(validNamedHit);
  if (shows.length >= 3) return shows;
  return (await load("urn:entity:movie")).filter(validNamedHit);
}

export async function loadPlaceHits<T>(
  load: (mode: PlaceMode) => Promise<T[]>,
  useAnchors: boolean,
  valid: (hit: T) => boolean,
): Promise<{ hits: T[]; chosenByCity: boolean }> {
  if (!useAnchors) {
    return { hits: (await load("city")).filter(valid), chosenByCity: true };
  }
  const anchored = (await load("anchors")).filter(valid);
  if (anchored.length >= 3) return { hits: anchored, chosenByCity: false };
  return { hits: (await load("city")).filter(valid), chosenByCity: true };
}

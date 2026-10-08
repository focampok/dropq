import type { InsightsParams } from "@/lib/qloo/types";

/**
 * Array parameters are serialized as one comma-separated query value.
 * The exact format is confirmed by the smoke script.
 */
export function serializeArray(values: string[]): string {
  return values.join(",");
}

function setArray(params: URLSearchParams, name: string, values: string[] | undefined) {
  if (!values || values.length === 0) return;
  params.set(name, serializeArray(values));
}

export function toSearchParams(args: { query: string; type?: string }): URLSearchParams {
  const params = new URLSearchParams();
  params.set("query", args.query);
  if (args.type) params.set("type", args.type);
  return params;
}

export function toTagsParams(args: { query: string; parentsTypes?: string }): URLSearchParams {
  const params = new URLSearchParams();
  params.set("filter.query", args.query);
  if (args.parentsTypes) params.set("filter.parents.types", args.parentsTypes);
  params.set("take", "20");
  return params;
}

export function toInsightsSearchParams(args: InsightsParams): URLSearchParams {
  const params = new URLSearchParams();
  params.set("filter.type", args.filterType);
  setArray(params, "signal.interests.entities", args.signalInterestsEntities);
  setArray(params, "signal.interests.tags", args.signalInterestsTags);
  if (args.signalLocationQuery) {
    params.set("signal.location.query", args.signalLocationQuery);
  }
  setArray(params, "filter.exclude.entities", args.filterExcludeEntities);
  setArray(params, "filter.tags", args.filterTags);
  if (args.filterPopularityMin !== undefined) {
    params.set("filter.popularity.min", String(args.filterPopularityMin));
  }
  if (args.filterPopularityMax !== undefined) {
    params.set("filter.popularity.max", String(args.filterPopularityMax));
  }
  if (args.biasTrends) params.set("bias.trends", args.biasTrends);
  if (args.explainability) params.set("feature.explainability", "true");
  if (args.filterGeocodeName) params.set("filter.geocode.name", args.filterGeocodeName);
  if (args.filterGeocodeCountryCode) {
    params.set("filter.geocode.country_code", args.filterGeocodeCountryCode);
  }
  if (args.filterLocation) params.set("filter.location", args.filterLocation);
  if (args.filterLocationRadius !== undefined) {
    params.set("filter.location.radius", String(args.filterLocationRadius));
  }
  if (args.take !== undefined) params.set("take", String(args.take));
  if (args.offset !== undefined) params.set("offset", String(args.offset));
  return params;
}

export function toCompareSearchParams(args: { a: string[]; b: string[] }): URLSearchParams {
  const params = new URLSearchParams();
  setArray(params, "a.signal.interests.entities", args.a);
  setArray(params, "b.signal.interests.entities", args.b);
  return params;
}

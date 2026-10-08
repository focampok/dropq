export const INSIGHT_ENTITY_TYPES = [
  "urn:entity:tv_show",
  "urn:entity:movie",
  "urn:entity:artist",
  "urn:entity:brand",
  "urn:entity:place",
] as const;

export type InsightEntityType = (typeof INSIGHT_ENTITY_TYPES)[number];

export type QlooResult<T> = {
  provenance: "qloo" | "mock";
  results: T;
  raw?: unknown;
};

export type QlooEntity = {
  entityId: string;
  name: string;
  type: string;
  imageUrl: string | null;
  raw: unknown;
};

export type QlooTag = {
  id: string;
  name: string;
  raw: unknown;
};

export type QlooInsightHit = {
  entityId: string;
  name: string;
  type: string;
  imageUrl: string | null;
  properties: Record<string, unknown>;
  raw: unknown;
};

export type InsightsParams = {
  filterType: InsightEntityType;
  signalInterestsEntities?: string[];
  signalInterestsTags?: string[];
  signalLocationQuery?: string;
  filterExcludeEntities?: string[];
  filterTags?: string[];
  filterPopularityMin?: number;
  filterPopularityMax?: number;
  biasTrends?: string;
  explainability?: boolean;
  filterGeocodeName?: string;
  filterGeocodeCountryCode?: string;
  filterLocation?: string;
  filterLocationRadius?: number;
  take?: number;
  offset?: number;
};

export class QlooHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Qloo request failed with status ${status}`);
    this.name = "QlooHttpError";
    this.status = status;
  }
}

export class QlooQuotaError extends Error {
  readonly code = "QUOTA_LOW" as const;

  constructor() {
    super("QUOTA_LOW");
    this.name = "QlooQuotaError";
  }
}

export class QlooGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QlooGuardError";
  }
}

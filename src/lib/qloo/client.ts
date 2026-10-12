import { qlooApiKey, resolveQlooBaseUrl } from "@/lib/qloo/config";
import { fixtureSearch } from "@/lib/qloo/fixtures";
import {
  serializeArray,
  toCompareSearchParams,
  toInsightsSearchParams,
  toSearchParams,
  toTagsParams,
} from "@/lib/qloo/params";
import {
  QlooGuardError,
  QlooHttpError,
  QlooQuotaError,
  type InsightsParams,
  type QlooEntity,
  type QlooInsightHit,
  type QlooResult,
  type QlooTag,
} from "@/lib/qloo/types";

const TIMEOUT_MS = 8_000;
const RETRY_BACKOFF_MS = 400;
const RATE_HEADER = /limit|retry|remaining|quota/i;

export type QlooHttpMeta = {
  status: number;
  body: unknown;
  rateHeaders: Record<string, string>;
};

type Budget = { remaining: number; consecutive429: number };

let budget: Budget | null = null;
let observedCalls = 0;
let monthRemaining: number | null = null;
let liveBlocked = false;
const recentStarts: number[] = [];

export function qlooQuota(): { remaining?: number; blocked: boolean } {
  return liveBlocked || monthRemaining !== null
    ? { remaining: monthRemaining ?? undefined, blocked: liveBlocked }
    : { blocked: false };
}

export function observedQlooCalls(): number {
  return observedCalls;
}

export function resetQlooRuntime(): void {
  budget = null;
  monthRemaining = null;
  liveBlocked = false;
  observedCalls = 0;
  recentStarts.length = 0;
}

export async function acquireQlooSlot(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (recentStarts.length > 0 && now - recentStarts[0]! >= 1000) recentStarts.shift();
    if (recentStarts.length < 4) {
      recentStarts.push(now);
      return;
    }
    await sleep(1000 - (now - recentStarts[0]!) + 1);
  }
}

export function enableSmokeGuards(maxCalls: number) {
  budget = { remaining: maxCalls, consecutive429: 0 };
}

function noteCall() {
  observedCalls += 1;
  if (!budget) return;
  if (budget.remaining <= 0) {
    throw new QlooGuardError("Qloo call cap reached");
  }
  budget.remaining -= 1;
}

function noteStatus(status: number) {
  if (!budget) return;
  if (status === 429) {
    budget.consecutive429 += 1;
    if (budget.consecutive429 >= 3) {
      throw new QlooGuardError("Aborted after 3 consecutive 429 responses");
    }
    return;
  }
  budget.consecutive429 = 0;
}

function headersFor(key: string): Headers {
  const headers = new Headers({ Accept: "application/json" });
  if (key) headers.set("X-Api-Key", key);
  return headers;
}

function networkDetail(error: unknown, key: string): string {
  const message = error instanceof Error ? error.message : "network error";
  return message.split(key).join("[redacted]").replace(/\s+/g, " ").slice(0, 240);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

function noteQuota(headers: Record<string, string>) {
  const raw = headers["x-month-ratelimit-remaining"];
  if (raw === undefined) return;
  const value = Number(raw);
  if (!Number.isFinite(value)) return;
  monthRemaining = value;
  if (value < 800) liveBlocked = true;
}

function retryAfterMs(response: Response): number {
  const raw = response.headers.get("retry-after");
  if (!raw) return RETRY_BACKOFF_MS;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, 10_000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 0), 10_000);
  return RETRY_BACKOFF_MS;
}
function rateHeadersFrom(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower === "x-api-key" || lower === "authorization" || lower === "cookie") return;
    if (RATE_HEADER.test(lower)) headers[name] = value;
  });
  return headers;
}

async function fetchOnce(url: URL, key: string, timeoutMs = TIMEOUT_MS): Promise<Response> {
  if (liveBlocked) throw new QlooQuotaError();
  await acquireQlooSlot();
  noteCall();
  const response = await fetch(url, {
    headers: headersFor(key),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  noteStatus(response.status);
  return response;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function perform(
  path: string,
  params: URLSearchParams,
  timeoutMs = TIMEOUT_MS,
): Promise<QlooHttpMeta> {
  const key = qlooApiKey();
  if (!key) {
    throw new Error("Qloo client must not call the network without a key");
  }
  const url = new URL(path, resolveQlooBaseUrl());
  url.search = params.toString();

  let response: Response;
  try {
    response = await fetchOnce(url, key, timeoutMs);
  } catch (error) {
    if (error instanceof QlooGuardError || error instanceof QlooQuotaError) throw error;
    const failure = new QlooHttpError(0);
    Object.assign(failure, { detail: networkDetail(error, key) });
    throw failure;
  }

  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new QlooHttpError(response.status);
  }

  if (shouldRetry(response.status)) {
    noteQuota(rateHeadersFrom(response));
    const delay = retryAfterMs(response);
    await response.body?.cancel();
    await sleep(delay);
    try {
      response = await fetchOnce(url, key, timeoutMs);
    } catch (error) {
      if (error instanceof QlooGuardError || error instanceof QlooQuotaError) throw error;
      const failure = new QlooHttpError(0);
      Object.assign(failure, { detail: networkDetail(error, key) });
      throw failure;
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new QlooHttpError(response.status);
    }
  }

  const rateHeaders = rateHeadersFrom(response);
  noteQuota(rateHeaders);
  const status = response.status;
  if (!response.ok) {
    const detail = (await response.text()).split(key).join("[redacted]").replace(/\s+/g, " ").slice(0, 240);
    const error = new QlooHttpError(status);
    if (detail) Object.assign(error, { detail });
    throw error;
  }
  return { status, body: await readBody(response), rateHeaders };
}

export async function qlooGet(
  path: string,
  params: URLSearchParams,
  timeoutMs = TIMEOUT_MS,
): Promise<QlooHttpMeta> {
  try {
    return await perform(path, params, timeoutMs);
  } catch (error) {
    if (error instanceof QlooHttpError && error.status !== 401 && error.status !== 403) {
      const detail =
        "detail" in error && typeof (error as { detail?: unknown }).detail === "string"
          ? (error as { detail: string }).detail
          : "";
      return { status: error.status, body: detail ? { error: detail } : null, rateHeaders: {} };
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function imageUrlFrom(properties: Record<string, unknown>): string | null {
  const image = properties.image;
  if (!isRecord(image)) return null;
  return asString(image.url) ?? null;
}

function entityType(record: Record<string, unknown>): string {
  const direct = asString(record.subtype) ?? asString(record.type);
  if (direct) return direct;
  if (Array.isArray(record.types)) {
    const first = record.types.find((entry) => typeof entry === "string");
    if (typeof first === "string") return first;
  }
  return "";
}

function resultList(body: unknown, key: "entities" | "tags"): unknown[] {
  if (Array.isArray(body)) return body;
  if (!isRecord(body)) return [];
  if (Array.isArray(body.results)) return body.results;
  if (isRecord(body.results) && Array.isArray(body.results[key])) {
    return body.results[key];
  }
  if (Array.isArray(body[key])) return body[key];
  return [];
}

function toEntity(value: unknown): QlooEntity | null {
  if (!isRecord(value)) return null;
  const entityId = asString(value.entity_id) ?? asString(value.id);
  if (!entityId) return null;
  const properties = isRecord(value.properties) ? value.properties : {};
  return {
    entityId,
    name: asString(value.name) ?? "",
    type: entityType(value),
    imageUrl: imageUrlFrom(properties),
    raw: value,
  };
}

function toHit(value: unknown): QlooInsightHit | null {
  if (!isRecord(value)) return null;
  const entityId = asString(value.entity_id) ?? asString(value.id);
  if (!entityId) return null;
  const properties = isRecord(value.properties) ? value.properties : {};
  return {
    entityId,
    name: asString(value.name) ?? "",
    type: entityType(value),
    imageUrl: imageUrlFrom(properties),
    properties,
    raw: value,
  };
}

function attachRates<T>(result: QlooResult<T>, rateHeaders: Record<string, string>): QlooResult<T> {
  return Object.assign(result, { rateHeaders });
}

function toTag(value: unknown): QlooTag | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id) ?? asString(value.tag_id);
  const name = asString(value.name) ?? "";
  if (!id && !name) return null;
  return { id: id ?? name, name, raw: value };
}

export async function search(args: {
  query: string;
  type?: string;
}): Promise<QlooResult<QlooEntity[]>> {
  if (!qlooApiKey()) {
    const fixture = fixtureSearch(args.query);
    return {
      provenance: "mock",
      results: fixture ? [fixture] : [],
    };
  }
  const response = await perform("/search", toSearchParams(args));
  return attachRates(
    {
      provenance: "qloo",
      results: resultList(response.body, "entities").flatMap((entry) => {
        const entity = toEntity(entry);
        return entity ? [entity] : [];
      }),
      raw: response.body,
    },
    response.rateHeaders,
  );
}

/** Tag names carried by an entity payload, from whichever shape the endpoint used. */
export function entityTagNames(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const tags = (raw as { tags?: unknown }).tags;
  if (!Array.isArray(tags)) return [];
  return tags.flatMap((tag) => {
    if (!tag || typeof tag !== "object") return [];
    const name = (tag as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  });
}

/**
 * The documented entity lookup. Search answers with award and role tags for an artist
 * ("Grammy Award Winners", "Actor"), while this returns the same entity's genre and mood
 * tags ("Reggaeton", "Latin Trap", "Energetic") — the ones the insights hits carry, so
 * shared tags finally mean something. Ids that the lookup does not know are simply absent.
 */
export async function entitiesByIds(ids: string[]): Promise<QlooResult<QlooEntity[]>> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) return { provenance: "qloo", results: [] };
  if (!qlooApiKey()) return { provenance: "mock", results: [] };
  const params = new URLSearchParams();
  params.set("entity_ids", serializeArray(unique));
  const response = await qlooGet("/entities", params);
  if (response.status !== 200) {
    return { provenance: "qloo", results: [], raw: response.body };
  }
  return attachRates(
    {
      provenance: "qloo",
      results: resultList(response.body, "entities").flatMap((entry) => {
        const entity = toEntity(entry);
        return entity ? [entity] : [];
      }),
      raw: response.body,
    },
    response.rateHeaders,
  );
}

export async function tags(args: { query: string; parentsTypes?: string }): Promise<QlooResult<QlooTag[]>> {
  if (!qlooApiKey()) {
    return { provenance: "mock", results: [] };
  }
  const response = await perform("/v2/tags", toTagsParams(args));
  return attachRates(
    {
      provenance: "qloo",
      results: resultList(response.body, "tags").flatMap((entry) => {
        const tag = toTag(entry);
        return tag ? [tag] : [];
      }),
      raw: response.body,
    },
    response.rateHeaders,
  );
}

export async function insights(
  args: InsightsParams,
  timeoutMs = TIMEOUT_MS,
): Promise<QlooResult<QlooInsightHit[]>> {
  if (!qlooApiKey()) {
    return { provenance: "mock", results: [] };
  }
  const response = await perform("/v2/insights", toInsightsSearchParams(args), timeoutMs);
  return attachRates(
    {
      provenance: "qloo",
      results: resultList(response.body, "entities").flatMap((entry) => {
        const hit = toHit(entry);
        return hit ? [hit] : [];
      }),
      raw: response.body,
    },
    response.rateHeaders,
  );
}

export async function analysisCompare(args: {
  a: string[];
  b: string[];
}): Promise<QlooResult<unknown>> {
  if (!qlooApiKey()) {
    return { provenance: "mock", results: null };
  }
  const response = await perform("/v2/analysis/compare", toCompareSearchParams(args));
  return attachRates(
    { provenance: "qloo", results: response.body, raw: response.body },
    response.rateHeaders,
  );
}

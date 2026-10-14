export const ALLOWED_QLOO_HOSTS = ["hackathon.api.qloo.com"];

const DEFAULT_BASE_URL = "https://hackathon.api.qloo.com";

export function qlooApiKey(): string {
  return process.env.QLOO_API_KEY?.trim() ?? "";
}

/**
 * Fixture short-circuit is for local/dev/test/smoke only. In production a missing
 * key must never fabricate Qloo entities — callers refuse live generation instead.
 */
export function qlooMocksAllowed(): boolean {
  return process.env.NODE_ENV !== "production";
}

export function resolveQlooBaseUrl(raw = process.env.QLOO_BASE_URL): URL {
  const value = raw?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("QLOO_BASE_URL is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Qloo host is not allowlisted");
  }
  if (!ALLOWED_QLOO_HOSTS.includes(url.hostname)) {
    throw new Error("Qloo host is not allowlisted");
  }
  return url;
}

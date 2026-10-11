import { NextResponse } from "next/server";
import { MAX_BODY_BYTES } from "@/lib/config";

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Read and parse a JSON body with a hard size cap. Returns a Response on failure.
 */
export async function readJsonBody(
  request: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<{ ok: true; value: unknown } | { ok: false; response: NextResponse }> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    return { ok: false, response: jsonError("body_too_large", 400) };
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, response: jsonError("invalid_body", 400) };
  }
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    return { ok: false, response: jsonError("body_too_large", 400) };
  }
  if (!raw.trim()) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, response: jsonError("invalid_body", 400) };
  }
}

export function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

/** Generic client error; never forward stack traces, SQL, upstream bodies or headers. */
export function safeServerError(error: unknown, logLabel = "request_failed"): NextResponse {
  const message = error instanceof Error ? error.message : "unknown";
  // Log only a short sanitized label — never secrets, SQL or upstream payloads.
  console.error(
    logLabel,
    message
      .replace(/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b/gi, "[sql]")
      .replace(/[A-Za-z0-9_-]{16,}/g, "[redacted]")
      .slice(0, 120),
  );
  return jsonError("internal_error", 500);
}

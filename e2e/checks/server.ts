/**
 * J1–J3: server surface. Pure HTTP, no browser, `prod-safe`.
 */
import { Acc, type Ctx } from "../lib/ctx";
import { nextForwarded } from "../lib/harness";

async function head(path: string, base: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-forwarded-for", nextForwarded());
  return fetch(`${base}${path}`, { ...init, headers, redirect: "manual" });
}

export async function runServerChecks(ctx: Ctx): Promise<void> {
  await checkJ1(ctx);
  await checkJ2(ctx);
  await checkJ3(ctx);
}

async function checkJ1(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("J1", "Security headers on / and an API route", "free");
  const https = new URL(ctx.base).protocol === "https:";
  for (const path of ["/", "/api/health"]) {
    const response = await head(path, ctx.base);
    await response.body?.cancel();
    const h = response.headers;
    const expect: [string, string][] = [
      ["x-content-type-options", "nosniff"],
      ["x-frame-options", "DENY"],
      ["referrer-policy", "strict-origin-when-cross-origin"],
    ];
    for (const [name, value] of expect) {
      if (h.get(name) !== value) acc.fail(`${path}: ${name} = ${h.get(name) ?? "(missing)"}`);
    }
    if (!h.get("permissions-policy")) acc.fail(`${path}: Permissions-Policy missing`);
    if (h.get("x-powered-by")) acc.fail(`${path}: X-Powered-By is present`);
    const hsts = h.get("strict-transport-security");
    if (https && !hsts) acc.fail(`${path}: Strict-Transport-Security missing over https`);
    if (!https) acc.note(`${path}: HSTS ${hsts ? "present (documented as production-only)" : "absent"} over http`);
  }
  acc.note("HSTS is gated on NODE_ENV=production, not on the request scheme; over http it is ignored by browsers.");
  acc.pass();
  acc.finish(ctx.recorder, Date.now() - started);
}

async function checkJ2(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("J2", "/api/health leaks nothing beyond {ok, db}", "free");
  const response = await head("/api/health", ctx.base);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    acc.fail("/api/health did not return JSON");
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const keys = Object.keys(body as Record<string, unknown>).sort();
    const allowed = new Set(["ok", "db"]);
    for (const key of keys) if (!allowed.has(key)) acc.fail(`/api/health exposes "${key}"`);
    if (!("ok" in body)) acc.fail("/api/health has no ok field");
  }
  for (const forbidden of ["version", "env", "key", "secret", "quota", "commit", "build"]) {
    if (text.toLowerCase().includes(forbidden)) acc.fail(`/api/health body mentions "${forbidden}"`);
  }
  acc.pass();
  acc.finish(ctx.recorder, Date.now() - started);
}

async function checkJ3(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("J3", "Malformed JSON returns a generic error without internals", "free");
  const response = await head("/api/session", ctx.base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{ this is not json",
  });
  const text = await response.text();
  if (response.status !== 400) acc.fail(`malformed JSON returned ${response.status}, expected 400`);
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    acc.fail("error response was not JSON");
  }
  if (body) {
    if (typeof body.error !== "string") acc.fail("error response has no error field");
    const keys = Object.keys(body);
    for (const key of keys) if (key !== "error") acc.fail(`error response leaks field "${key}"`);
  }
  for (const leak of ["at ", "SELECT", "FROM ", "stack", "Error:", "postgres", "prisma"]) {
    if (text.includes(leak)) acc.fail(`error body contains "${leak}"`);
  }
  acc.pass();
  acc.finish(ctx.recorder, Date.now() - started);
}

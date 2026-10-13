/**
 * F1–F2: session isolation and cookie attributes. `prod-safe`, `free`.
 */
import { Acc, type Ctx } from "../lib/ctx";
import { ApiJar, nextForwarded } from "../lib/harness";
import { PRESET_SEEDS } from "../lib/app";

export async function runSessionChecks(ctx: Ctx): Promise<void> {
  await checkF1(ctx);
  await checkF2(ctx);
}

async function makeSession(jar: ApiJar, city = "Los Angeles"): Promise<string | null> {
  const created = await jar.json<{ id?: string }>("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ city, eventKind: "comunidad", locale: "en" }),
  });
  const id = created.body?.id;
  if (!id) return null;
  await jar.json(`/api/session/${id}/seeds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      seeds: (PRESET_SEEDS["roots-gt-la"] ?? []).map((rawText) => ({ rawText, source: "preset" })),
    }),
  });
  return id;
}

async function checkF1(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("F1", "A pack id is reachable only with its own cookie", "free");
  const owner = new ApiJar(ctx.base);
  const id = await makeSession(owner);
  if (!id) {
    acc.fail("could not create a session");
    acc.finish(ctx.recorder, Date.now() - started);
    return;
  }
  const path = `/api/session/${id}/packs/latest`;

  const stranger = new ApiJar(ctx.base);
  const a = await stranger.request(path);
  await a.body?.cancel();
  if (a.status !== 403) acc.fail(`a second cookie jar got ${a.status}, expected 403`);

  const cookie = owner.rawCookies().find((entry) => entry.name === "dropq_sid");
  if (!cookie) {
    acc.fail("the owner jar has no session cookie");
  } else {
    const tampered = `${cookie.value.slice(0, -3)}zzz`;
    const response = await fetch(`${ctx.base}${path}`, {
      headers: { "x-forwarded-for": nextForwarded(), cookie: `dropq_sid=${tampered}` },
    });
    await response.body?.cancel();
    if (response.status !== 403) acc.fail(`a tampered cookie got ${response.status}, expected 403`);
  }

  const noCookie = await fetch(`${ctx.base}${path}`, { headers: { "x-forwarded-for": nextForwarded() } });
  await noCookie.body?.cancel();
  if (noCookie.status !== 403) acc.fail(`a request with no cookie got ${noCookie.status}, expected 403`);

  acc.pass();
  acc.finish(ctx.recorder, Date.now() - started);
}

async function checkF2(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("F2", "The session cookie is HttpOnly and SameSite=Lax", "free");
  const https = new URL(ctx.base).protocol === "https:";
  const response = await fetch(`${ctx.base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": nextForwarded() },
    body: JSON.stringify({ city: "Houston", eventKind: "tour", locale: "en" }),
  });
  await response.text();
  const raw = (response.headers.getSetCookie?.() ?? []).find((entry) => entry.startsWith("dropq_sid="));
  if (!raw) {
    acc.fail("POST /api/session set no dropq_sid cookie");
    acc.finish(ctx.recorder, Date.now() - started);
    return;
  }
  const lower = raw.toLowerCase();
  if (!lower.includes("httponly")) acc.fail("session cookie is not HttpOnly");
  if (!/samesite=lax/.test(lower)) acc.fail("session cookie is not SameSite=Lax");
  if (https && !lower.includes("secure")) acc.fail("session cookie is not Secure over https");
  if (!https && lower.includes("secure")) acc.note("session cookie is Secure over http (production build)");
  acc.pass();
  acc.finish(ctx.recorder, Date.now() - started);
}

/**
 * G1–G4: input validation, the friendly rate-limit and quota messages, and the cheap
 * limit for cached reads. G4 is local-only (it exercises the in-memory limiter directly);
 * G2/G3 use a mocked response, so no quota is spent.
 */
import type { BrowserContext, Route } from "playwright";
import { Acc, type Ctx } from "../lib/ctx";
import { ApiJar, nextForwarded } from "../lib/harness";
import { PRESET_SEEDS, dict, presetLabel } from "../lib/app";
import { gotoHome, setLocaleCookie, waitForHydrated } from "../lib/page";

export async function runLimitApiChecks(ctx: Ctx): Promise<void> {
  await checkG1(ctx);
  if (ctx.profile === "local") await checkG4(ctx);
}

export async function runLimitMessageChecks(ctx: Ctx): Promise<void> {
  await checkG2(ctx);
  await checkG3(ctx);
}

async function checkG1(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("G1", "Invalid bodies are rejected without spending quota", "free");
  const local = ctx.profile === "local";
  const before = local ? await ctx.qlooBuiltSince(ctx.runStart) : 0;

  const jar = new ApiJar(ctx.base);
  const session = await jar.json<{ id?: string }>("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ city: "Los Angeles", eventKind: "tour", locale: "en" }),
  });
  const id = session.body?.id;
  if (!id) {
    acc.fail("could not create a session for the validation checks");
    acc.finish(ctx.recorder, Date.now() - started);
    return;
  }
  const post = (path: string, body: string) =>
    jar.json(path, { method: "POST", headers: { "Content-Type": "application/json" }, body });

  const tooMany = await post(`/api/session/${id}/seeds`, JSON.stringify({
    seeds: Array.from({ length: 6 }, (_, i) => ({ rawText: `Seed ${i}`, source: "text" })),
  }));
  if (tooMany.status !== 400) acc.fail(`6 seeds returned ${tooMany.status}, expected 400`);

  const longSeed = await post(`/api/session/${id}/seeds`, JSON.stringify({
    seeds: [1, 2, 3].map((i) => ({ rawText: "x".repeat(200), source: "text" })),
  }));
  if (longSeed.status !== 400) acc.fail(`a 200-char seed returned ${longSeed.status}, expected 400`);

  const big = await post("/api/session", JSON.stringify({ city: "Los Angeles", pad: "y".repeat(11 * 1024) }));
  if (big.status !== 400) acc.fail(`an >10 KB body returned ${big.status}, expected 400`);

  const badLang = await post(`/api/session/${id}/pack`, JSON.stringify({ lang: "fr" }));
  if (badLang.status !== 400) acc.fail(`lang="fr" returned ${badLang.status}, expected 400`);

  const badKind = await post(`/api/session/${id}/pack`, JSON.stringify({ kind: "party" }));
  if (badKind.status !== 400) acc.fail(`kind="party" returned ${badKind.status}, expected 400`);

  if (local) {
    const after = await ctx.qlooBuiltSince(ctx.runStart);
    if (after !== before) acc.fail(`Qloo build count moved ${before} -> ${after} during validation`);
    acc.note("validated that no PackCache row was written (Qloo counter unchanged)");
  } else {
    acc.note("prod profile: request counters are not observable; only statuses were checked");
  }

  acc.pass();
  acc.finish(ctx.recorder, Date.now() - started);
}

type Mock = { status: number; body: string; retryAfter?: string };

async function mockPackMessage(
  ctx: Ctx,
  acc: Acc,
  locale: "en" | "es",
  mock: Mock,
  expected: string,
): Promise<void> {
  let context: BrowserContext | null = null;
  try {
    context = await ctx.browser.newContext({
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { "x-forwarded-for": nextForwarded() },
    });
    await setLocaleCookie(context, ctx.base, locale);
    const page = await context.newPage();
    const handler = async (route: Route): Promise<void> => {
      await route.fulfill({
        status: mock.status,
        contentType: "application/json",
        headers: mock.retryAfter ? { "Retry-After": mock.retryAfter } : {},
        body: mock.body,
      });
    };
    await context.route("**/api/session/*/pack", handler);
    await gotoHome(page, ctx.base);
    await waitForHydrated(page);
    await page.getByRole("button", { name: presetLabel(locale, "roots-gt-la"), exact: true }).click();
    await page.getByRole("button", { name: /Pack the night|Armar la noche/ }).click();
    await page.waitForURL(/\/pack\?session=/, { timeout: 60_000 });
    // Wait for the message text, not just the element: the alert can mount a beat before
    // the localized string is committed.
    await page.waitForFunction(
      () => {
        const element = document.querySelector('[role="alert"]');
        return Boolean(element && (element.textContent ?? "").trim().length > 0);
      },
      undefined,
      { timeout: 30_000 },
    );
    const text = (await page.getByRole("alert").first().textContent())?.trim() ?? "";
    if (text !== expected) acc.fail(`${locale}: mocked ${mock.status} showed "${text}", expected "${expected}"`);
    if (text.includes("{")) acc.fail(`${locale}: the UI showed raw JSON`);
    // Locally, prove recovery by loading a real cached preset. In prod the suite shares
    // one IP bucket with every other check, so a real pack here trips pack_cheap before A/B.
    if (ctx.profile === "local") {
      await context.unroute("**/api/session/*/pack", handler);
      await gotoHome(page, ctx.base);
      await waitForHydrated(page);
      await page.getByRole("button", { name: presetLabel(locale, "roots-gt-la"), exact: true }).click();
      await page.getByRole("button", { name: /Pack the night|Armar la noche/ }).click();
      await page.waitForURL(/\/pack\?session=/, { timeout: 60_000 });
      await page.waitForSelector("section h3", { timeout: 60_000 });
    }
    acc.pass();
  } catch (error) {
    acc.fail(`${locale}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  } finally {
    await context?.close();
  }
}

async function checkG2(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("G2", "A 429 shows the friendly localized message", "free");
  for (const locale of ["en", "es"] as const) {
    await mockPackMessage(
      ctx,
      acc,
      locale,
      { status: 429, retryAfter: "30", body: JSON.stringify({ error: "rate_limited" }) },
      dict(locale).pack.rateLimited,
    );
  }
  acc.finish(ctx.recorder, Date.now() - started);
}

async function checkG3(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("G3", "A resting/quota response shows the localized message", "free");
  await mockPackMessage(
    ctx,
    acc,
    "en",
    { status: 503, body: JSON.stringify({ error: "DEMO_RESTING" }) },
    dict("en").pack.demoResting,
  );
  await mockPackMessage(
    ctx,
    acc,
    "en",
    { status: 503, body: JSON.stringify({ error: "QUOTA_LOW" }) },
    dict("en").pack.quotaLow,
  );
  acc.finish(ctx.recorder, Date.now() - started);
}

async function checkG4(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("G4", "Seven rapid cached reads are not blocked", "free");
  const jar = new ApiJar(ctx.base);
  const session = await jar.json<{ id?: string }>("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ city: "Los Angeles", eventKind: "comunidad", locale: "en" }),
  });
  const id = session.body?.id;
  if (!id) {
    acc.fail("could not create a session");
    acc.finish(ctx.recorder, Date.now() - started);
    return;
  }
  await jar.json(`/api/session/${id}/seeds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      seeds: (PRESET_SEEDS["roots-gt-la"] ?? []).map((rawText) => ({ rawText, source: "preset" })),
    }),
  });
  const statuses: number[] = [];
  for (let index = 0; index < 7; index += 1) {
    const result = await jar.stream(`/api/session/${id}/pack`, "{}");
    statuses.push(result.status);
  }
  const blocked = statuses.filter((status) => status === 429).length;
  if (blocked > 0) acc.fail(`${blocked} of 7 cached reads were rate-limited (${statuses.join(",")})`);
  acc.note(`cached read statuses: ${statuses.join(", ")}`);
  acc.pass();
  acc.finish(ctx.recorder, Date.now() - started);
}

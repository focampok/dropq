/**
 * S1-1..S1-5: printable pack brief.
 *
 * Preset paths are cache hits only in prod. S1-4 (custom owner vs stranger) is
 * local-only; prod records SKIP:profile.
 */
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrowserContext, Page } from "playwright";
import { Acc, type Ctx } from "../lib/ctx";
import { VIEWPORTS, nextForwarded } from "../lib/harness";
import { dict, presetLabel } from "../lib/app";
import { createCustomBriefFixture, deleteSessionCascade } from "../lib/db";
import {
  DONE,
  gotoHome,
  loadPreset,
  readLatest,
  setLocaleCookie,
  waitForHydrated,
  waitForStreamDone,
  watchConsole,
} from "../lib/page";

const execFileAsync = promisify(execFile);

async function pdfText(pdf: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dropq-brief-"));
  const pdfPath = join(dir, "brief.pdf");
  const txtPath = join(dir, "brief.txt");
  try {
    await writeFile(pdfPath, pdf);
    await execFileAsync("pdftotext", ["-layout", pdfPath, txtPath]);
    return await readFile(txtPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const PACK_BUTTON = /Pack the night|Armar la noche/;
const PRESET = "roots-gt-la";

async function openPresetPack(
  ctx: Ctx,
  locale: "en" | "es",
  viewport = { width: 1280, height: 800 },
): Promise<{ context: BrowserContext; page: Page; packId: string }> {
  const context = await ctx.browser.newContext({
    viewport,
    extraHTTPHeaders: { "x-forwarded-for": nextForwarded() },
  });
  await setLocaleCookie(context, ctx.base, locale);
  const page = await context.newPage();
  await gotoHome(page, ctx.base);
  await loadPreset(page, ctx.base, presetLabel(locale, PRESET), PACK_BUTTON, {
    requireCacheHit: ctx.profile === "prod",
    where: `S1 ${locale}`,
  });
  await waitForStreamDone(page);
  await page.waitForSelector(DONE, { state: "attached", timeout: 30_000 });
  const latest = await readLatest(page, ctx.base);
  const packId = latest?.plans?.find((plan) => plan.label === "A")?.id ?? latest?.plans?.[0]?.id;
  if (!packId) throw new Error("packs/latest had no pack id for the brief");
  return { context, page, packId };
}

function slotNamesFromPage(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-slot]")).map((row) => {
      const name = row.querySelector("td p.font-medium, td .font-medium");
      return (name?.textContent ?? "").trim();
    }),
  );
}

export async function runBriefChecks(ctx: Ctx): Promise<void> {
  await checkS11(ctx);
  await checkS12(ctx);
  await checkS13(ctx);
  if (ctx.profile === "local") await checkS14(ctx);
  else {
    const acc = new Acc("S1-4", "Custom brief owner vs stranger", "free");
    acc.finishSkipped(ctx.recorder, "profile");
  }
  await checkS15(ctx);
}

async function checkS11(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("S1-1", "Preset brief renders in EN with both plans and 8 slots", "free");
  let context: BrowserContext | null = null;
  try {
    const opened = await openPresetPack(ctx, "en");
    context = opened.context;
    const page = opened.page;
    await page.goto(`${ctx.base}/packs/${opened.packId}/brief`, { waitUntil: "domcontentloaded" });
    await waitForHydrated(page);
    const roots = await page.getByRole("heading", { name: dict("en").brief.planRoots }).count();
    const bridge = await page.getByRole("heading", { name: dict("en").brief.planBridge }).count();
    if (roots < 1 || bridge < 1) acc.fail("both plan headings required");
    const slots = await page.locator("[data-slot]").count();
    if (slots !== 8) acc.fail(`expected 8 slots, got ${slots}`);
    const api = await page.request.get(`${ctx.base}/api/packs/${opened.packId}/brief?lang=en`);
    if (!api.ok()) acc.fail(`brief JSON status ${api.status()}`);
    else {
      const body = (await api.json()) as { plans?: { items?: unknown[] }[] };
      const count = body.plans?.reduce((sum, plan) => sum + (plan.items?.length ?? 0), 0) ?? 0;
      if (count !== 8) acc.fail(`JSON brief had ${count} items`);
      const cache = api.headers()["cache-control"] ?? "";
      if (!/public/i.test(cache) && !/max-age/i.test(cache)) {
        acc.note(`Cache-Control=${cache || "missing"}`);
      }
    }
    acc.pass();
  } catch (error) {
    acc.fail(error instanceof Error ? error.message.split("\n")[0]! : String(error));
  } finally {
    await context?.close();
  }
  acc.finish(ctx.recorder, Date.now() - started);
}

async function checkS12(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("S1-2", "EN→ES brief switch keeps the same entity names", "free");
  let context: BrowserContext | null = null;
  try {
    const opened = await openPresetPack(ctx, "en");
    context = opened.context;
    const page = opened.page;
    await page.goto(`${ctx.base}/packs/${opened.packId}/brief`, { waitUntil: "domcontentloaded" });
    await waitForHydrated(page);
    const enNames = await slotNamesFromPage(page);
    await page
      .getByRole("group", { name: /Language|Idioma/ })
      .getByRole("button", { name: "ES", exact: true })
      .click();
    await page.waitForFunction(
      () => document.documentElement.lang === "es" || Boolean(document.querySelector("#brief-plan-A")),
      undefined,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(400);
    const esNames = await slotNamesFromPage(page);
    if (enNames.length !== 8 || esNames.length !== 8) {
      acc.fail(`slot counts en=${enNames.length} es=${esNames.length}`);
    }
    if (JSON.stringify(enNames) !== JSON.stringify(esNames)) {
      acc.fail(`entity names changed on language toggle`);
    }
    const esHeading = await page.getByRole("heading", { name: dict("es").brief.planRoots }).count();
    if (esHeading < 1) acc.fail("ES plan heading missing after toggle");
    acc.pass();
  } catch (error) {
    acc.fail(error instanceof Error ? error.message.split("\n")[0]! : String(error));
  } finally {
    await context?.close();
  }
  acc.finish(ctx.recorder, Date.now() - started);
}

async function checkS13(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("S1-3", "Print emulation hides chrome and PDF contains all slot names", "free");
  let context: BrowserContext | null = null;
  try {
    const opened = await openPresetPack(ctx, "en");
    context = opened.context;
    const page = opened.page;
    await page.goto(`${ctx.base}/packs/${opened.packId}/brief`, { waitUntil: "domcontentloaded" });
    await waitForHydrated(page);
    const names = await slotNamesFromPage(page);
    if (names.length !== 8 || names.some((name) => !name)) {
      acc.fail(`need 8 named slots before print, got ${names.length}`);
    }
    await page.emulateMedia({ media: "print" });
    const chromeHidden = await page.evaluate(() => {
      const chrome = document.querySelector(".brief-chrome");
      if (!chrome) return true;
      return getComputedStyle(chrome).display === "none";
    });
    if (!chromeHidden) acc.fail("brief chrome still visible in print media");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    if (overflow) acc.fail("horizontal overflow in print media");
    const pdf = await page.pdf({ format: "Letter", printBackground: true });
    if (pdf.byteLength < 500) acc.fail("PDF too small");
    const raw = Buffer.from(pdf).toString("latin1");
    const pages = (raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    if (pages < 1) acc.fail("PDF had no page objects");
    // Compressed PDF streams hide Unicode; extract text with pdftotext (system tool).
    const text = await pdfText(pdf);
    for (const name of names) {
      if (!text.includes(name)) acc.fail(`PDF missing slot name "${name}"`);
    }
    acc.note(`pdf bytes=${pdf.byteLength} pages≈${pages}`);
    acc.pass();
  } catch (error) {
    acc.fail(error instanceof Error ? error.message.split("\n")[0]! : String(error));
  } finally {
    await context?.close();
  }
  acc.finish(ctx.recorder, Date.now() - started);
}

async function checkS14(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("S1-4", "Custom brief owner can open; stranger gets generic 404", "free");
  let owner: BrowserContext | null = null;
  let stranger: BrowserContext | null = null;
  let sessionId: string | null = null;
  try {
    const fixture = await createCustomBriefFixture();
    sessionId = fixture.sessionId;
    owner = await ctx.browser.newContext({
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { "x-forwarded-for": nextForwarded() },
    });
    await owner.addCookies([
      {
        name: "dropq_sid",
        value: fixture.cookieValue,
        domain: new URL(ctx.base).hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const ownerPage = await owner.newPage();
    const ok = await ownerPage.request.get(`${ctx.base}/api/packs/${fixture.packId}/brief?lang=en`);
    if (!ok.ok()) acc.fail(`owner brief status ${ok.status()}`);
    const cache = ok.headers()["cache-control"] ?? "";
    if (!/private/i.test(cache) || !/no-store/i.test(cache)) {
      acc.fail(`custom Cache-Control expected private,no-store got "${cache}"`);
    }
    const pageRes = await ownerPage.goto(`${ctx.base}/packs/${fixture.packId}/brief`);
    if (!pageRes || pageRes.status() >= 400) acc.fail(`owner HTML status ${pageRes?.status()}`);
    await ownerPage.waitForSelector("[data-brief]", { timeout: 15_000 });

    stranger = await ctx.browser.newContext({
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { "x-forwarded-for": nextForwarded() },
    });
    const strangerPage = await stranger.newPage();
    const denied = await strangerPage.request.get(`${ctx.base}/api/packs/${fixture.packId}/brief`);
    if (denied.status() !== 404) acc.fail(`stranger API status ${denied.status()}, expected 404`);
    const deniedBody = await denied.text();
    if (/session_|UniqueAnchor/i.test(deniedBody)) acc.fail("404 body leaked existence details");
    const html = await strangerPage.goto(`${ctx.base}/packs/${fixture.packId}/brief`);
    if (!html || html.status() !== 404) acc.fail(`stranger HTML status ${html?.status()}`);
    acc.pass();
  } catch (error) {
    acc.fail(error instanceof Error ? error.message.split("\n")[0]! : String(error));
  } finally {
    await owner?.close();
    await stranger?.close();
    if (sessionId) await deleteSessionCascade(sessionId);
  }
  acc.finish(ctx.recorder, Date.now() - started);
}

async function checkS15(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("S1-5", "Brief axe desktop/mobile 0 serious/critical, no horizontal scroll", "free");
  let AxeBuilder: typeof import("@axe-core/playwright").default | null = null;
  try {
    AxeBuilder = (await import("@axe-core/playwright")).default;
  } catch {
    acc.finishSkipped(ctx.recorder, "axe-not-installed");
    return;
  }
  for (const viewport of VIEWPORTS) {
    let context: BrowserContext | null = null;
    try {
      const opened = await openPresetPack(ctx, "en", {
        width: viewport.width,
        height: viewport.height,
      });
      context = opened.context;
      const page = opened.page;
      const issues = watchConsole(page);
      await page.goto(`${ctx.base}/packs/${opened.packId}/brief`, { waitUntil: "domcontentloaded" });
      await waitForHydrated(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      if (overflow) acc.fail(`${viewport.name}: horizontal scroll`);
      let results: Awaited<ReturnType<InstanceType<typeof AxeBuilder>["analyze"]>> | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          results = await new AxeBuilder!({ page }).analyze();
          break;
        } catch {
          await page.waitForTimeout(500);
        }
      }
      if (!results) {
        acc.fail(`${viewport.name}: axe failed`);
      } else {
        const serious = results.violations.filter(
          (v) => v.impact === "serious" || v.impact === "critical",
        );
        if (serious.length > 0) {
          acc.fail(`${viewport.name}: ${serious.map((v) => v.id).join(",")}`);
        } else {
          acc.note(`${viewport.name}: axe 0 serious/critical`);
        }
      }
      if (issues.consoleErrors.length || issues.pageErrors.length) {
        acc.fail(`${viewport.name}: console errors`);
      }
      acc.pass();
    } catch (error) {
      acc.fail(
        `${viewport.name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      );
    } finally {
      await context?.close();
    }
  }
  acc.finish(ctx.recorder, Date.now() - started);
}

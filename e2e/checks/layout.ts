/**
 * I1–I4: layout, keyboard, console/network hygiene and reload-during-stream.
 * `prod-safe`, `free` (cached preset loads only; the Deep cuts toggle is never activated
 * from a keyboard check).
 */
import type { BrowserContext, Page } from "playwright";
import { Acc, type Ctx } from "../lib/ctx";
import { nextForwarded, VIEWPORTS } from "../lib/harness";
import { presetLabel } from "../lib/app";
import {
  gotoHome,
  isHydrated,
  loadPreset,
  readLatest,
  expandTagToggles,
  scrollThrough,
  waitForHydrated,
  waitForStreamDone,
  watchConsole,
  type ConsoleIssues,
} from "../lib/page";

const PRESET = "roots-gt-la";
const PACK_BUTTON = /Pack the night|Armar la noche/;

async function newContext(ctx: Ctx): Promise<BrowserContext> {
  return ctx.browser.newContext({
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { "x-forwarded-for": nextForwarded() },
  });
}

async function overflows(page: Page, width: number, height: number): Promise<boolean> {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(150);
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
}

export async function runLayoutChecks(ctx: Ctx): Promise<void> {
  await checkI1(ctx);
  await checkI2(ctx);
  await checkI3(ctx);
  await checkI4(ctx);
  await checkI5(ctx);
}

async function checkI1(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("I1", "No horizontal scroll at 390 px or 1280 px", "free");
  let context: BrowserContext | null = null;
  try {
    context = await newContext(ctx);
    const page = await context.newPage();
    await gotoHome(page, ctx.base);
    const screens: [string, boolean][] = [];
    for (const viewport of VIEWPORTS) {
      screens.push([`onboarding@${viewport.name}`, await overflows(page, viewport.width, viewport.height)]);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await waitForHydrated(page);
    await page.getByRole("button", { name: presetLabel("en", PRESET), exact: true }).click();
    await page.getByRole("button", { name: PACK_BUTTON }).click();
    await page.waitForURL(/\/pack\?session=/, { timeout: 60_000 });
    for (const viewport of VIEWPORTS) {
      screens.push([`stream@${viewport.name}`, await overflows(page, viewport.width, viewport.height)]);
    }
    await waitForStreamDone(page);
    await scrollThrough(page);
    for (const viewport of VIEWPORTS) {
      screens.push([`pack@${viewport.name}`, await overflows(page, viewport.width, viewport.height)]);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await expandTagToggles(page);
    for (const viewport of VIEWPORTS) {
      screens.push([`evidence@${viewport.name}`, await overflows(page, viewport.width, viewport.height)]);
    }
    for (const [name, over] of screens) if (over) acc.fail(`${name} scrolls horizontally`);
    acc.note(`checked ${screens.length} screen/viewport combinations`);
    acc.pass();
  } catch (error) {
    acc.fail(error instanceof Error ? error.message.split("\n")[0]! : String(error));
  } finally {
    await context?.close();
  }
  acc.finish(ctx.recorder, Date.now() - started);
}

type FocusInfo = {
  tag: string;
  text: string;
  aria: string;
  hasRing: boolean;
};

async function focusInfo(page: Page): Promise<FocusInfo | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const style = getComputedStyle(el);
    const outlineOn = style.outlineStyle !== "none" && style.outlineWidth !== "0px";
    return {
      tag: el.tagName,
      text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40),
      aria: el.getAttribute("aria-label") ?? "",
      hasRing: outlineOn || style.boxShadow !== "none",
    };
  });
}

async function tabUntil(page: Page, match: (info: FocusInfo) => boolean, max = 60): Promise<FocusInfo | null> {
  for (let index = 0; index < max; index += 1) {
    await page.keyboard.press("Tab");
    const info = await focusInfo(page);
    if (info && match(info)) return info;
  }
  return null;
}

async function checkI2(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("I2", "Keyboard reaches and operates the controls with a focus ring", "free");
  let context: BrowserContext | null = null;
  try {
    context = await newContext(ctx);
    const page = await context.newPage();
    await gotoHome(page, ctx.base);
    // Controls are disabled until the app is interactive, so wait for it: Tab would skip
    // them and Enter would do nothing.
    await waitForHydrated(page);
    const preset = presetLabel("en", PRESET);
    const presetHit = await tabUntil(page, (info) => info.text === preset);
    if (!presetHit) acc.fail("Tab never reached a preset button");
    else if (!presetHit.hasRing) acc.fail("the preset button has no visible focus ring");
    // Enter operates the preset (it fills the seeds).
    if (presetHit) {
      await page.keyboard.press("Enter");
      const value = await page.locator("#anchor-0").inputValue();
      if (!value.trim()) acc.fail("Enter on a preset button did not fill the anchors");
    }
    const generate = await tabUntil(page, (info) => /Pack the night/.test(info.text));
    if (!generate) acc.fail("Tab never reached the generate button");
    const language = await tabUntil(page, (info) => info.text === "ES" && info.aria === "");
    if (!language) acc.fail("Tab never reached the language toggle");
    else if (!language.hasRing) acc.fail("the language toggle has no visible focus ring");

    // On the pack screen: the Deep cuts toggle and a tag-list disclosure are reachable.
    await gotoHome(page, ctx.base);
    await loadPreset(page, ctx.base, presetLabel("en", PRESET), PACK_BUTTON);
    await waitForStreamDone(page);
    await page.locator("body").click({ position: { x: 2, y: 2 } });
    const deep = await tabUntil(page, (info) => /Deep cuts/.test(info.text), 120);
    if (!deep) acc.fail("Tab never reached the Deep cuts toggle");
    else if (!deep.hasRing) acc.fail("the Deep cuts toggle has no visible focus ring");
    const disclosure = await tabUntil(page, (info) => /^\+\d+ more$/.test(info.text), 120);
    if (!disclosure) acc.note("no +N more disclosure was reachable on this pack");
    else if (!disclosure.hasRing) acc.fail("the tag disclosure has no visible focus ring");
    // Space operates the tag disclosure.
    if (disclosure) {
      const before = await page.evaluate(() => document.activeElement?.textContent ?? "");
      await page.keyboard.press(" ");
      const after = await page.evaluate(() => document.activeElement?.textContent ?? "");
      if (before === after) acc.fail("Space did not operate the tag disclosure");
    }
    acc.pass();
  } catch (error) {
    acc.fail(error instanceof Error ? error.message.split("\n")[0]! : String(error));
  } finally {
    await context?.close();
  }
  acc.finish(ctx.recorder, Date.now() - started);
}

async function checkI3(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("I3", "0 console errors, 0 failed requests, 0 rejections", "free");
  let context: BrowserContext | null = null;
  try {
    context = await newContext(ctx);
    const page = await context.newPage();
    const issues: ConsoleIssues = watchConsole(page);
    await gotoHome(page, ctx.base);
    await loadPreset(page, ctx.base, presetLabel("en", PRESET), PACK_BUTTON);
    await waitForStreamDone(page);
    await scrollThrough(page);
    await expandTagToggles(page);
    const group = page.getByRole("group", { name: /Language|Idioma/ });
    await group.getByRole("button", { name: "ES", exact: true }).click();
    await page.waitForTimeout(1500);
    await group.getByRole("button", { name: "EN", exact: true }).click();
    await page.waitForTimeout(1500);
    if (issues.consoleErrors.length > 0) acc.fail(`console errors: ${issues.consoleErrors.slice(0, 3).join(" | ")}`);
    if (issues.pageErrors.length > 0) acc.fail(`page errors: ${issues.pageErrors.slice(0, 3).join(" | ")}`);
    if (issues.failedRequests.length > 0) acc.fail(`failed requests: ${issues.failedRequests.slice(0, 3).join(" | ")}`);
    acc.note(
      `observed ${issues.all.failures.length} aborted stream read(s), ignored as benign; ${issues.all.consoleErrors.length} console errors`,
    );
    acc.pass();
  } catch (error) {
    acc.fail(error instanceof Error ? error.message.split("\n")[0]! : String(error));
  } finally {
    await context?.close();
  }
  acc.finish(ctx.recorder, Date.now() - started);
}

/** How long I5 holds the app's own bundles back, so hydration lands after the paint. */
const HYDRATION_DELAY_MS = 4_000;

/**
 * The defect this check exists for: the onboarding form is server-rendered, so on a slow
 * connection its submit button is tappable before React has attached the handler, and the
 * tap becomes a native GET submit — the visitor lands on `/?` with nothing selected. The
 * app now renders every client control disabled until a client effect reports hydration,
 * so a tap in that window is inert; the same tap works once the page says it is ready.
 */
async function checkI5(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("I5", "A click before hydration is inert; the same click works after it", "free");
  let context: BrowserContext | null = null;
  try {
    context = await newContext(ctx);
    const page = await context.newPage();
    await page.route("**/_next/static/chunks/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, HYDRATION_DELAY_MS));
      await route.continue();
    });
    await gotoHome(page, ctx.base);
    if (await isHydrated(page)) {
      acc.fail("the page reported itself hydrated while its own bundles were still held back");
    }

    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(new URL(frame.url()).pathname);
    });

    const packButton = page.getByRole("button", { name: PACK_BUTTON });
    const presetButton = page.getByRole("button", { name: presetLabel("en", PRESET), exact: true });
    if (!(await packButton.isDisabled().catch(() => false))) {
      acc.fail("the pack button is enabled before hydration, so a tap submits the form natively");
    }
    if (!(await presetButton.isDisabled().catch(() => false))) {
      acc.fail("a preset button is enabled before hydration, so a tap there does nothing");
    }
    // `force` skips Playwright's actionability wait on purpose: this is the slow-phone tap.
    await packButton.click({ force: true, timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(700);
    await presetButton.click({ force: true, timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(300);
    if (navigations.length > 0) {
      acc.fail(`a click before hydration navigated to ${navigations.join(" -> ")}`);
    }
    const where = new URL(page.url());
    if (`${where.pathname}${where.search}` !== "/") {
      acc.fail(`a click before hydration left the onboarding page at ${where.pathname}${where.search}`);
    }
    if ((await page.locator("#anchor-0").inputValue()).trim()) {
      acc.fail("a click before hydration changed the anchors");
    }

    await waitForHydrated(page);
    if (await packButton.isDisabled()) acc.fail("the pack button is still disabled after hydration");
    await presetButton.click();
    const filled = (await page.locator("#anchor-0").inputValue()).trim();
    if (!filled) acc.fail("after hydration the same preset click did not fill the anchors");
    else acc.note(`after hydration the preset click filled the first anchor in ${Date.now() - started} ms`);
    acc.pass();
  } catch (error) {
    acc.fail(error instanceof Error ? error.message.split("\n")[0]! : String(error));
  } finally {
    await context?.close();
  }
  acc.finish(ctx.recorder, Date.now() - started);
}

async function checkI4(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("I4", "A reload during streaming leaves the session usable", "free");
  let context: BrowserContext | null = null;
  try {
    context = await newContext(ctx);
    const page = await context.newPage();
    const sighting = { status: null as number | null, cache: null as string | null, retryAfter: null as string | null };
    page.on("response", (response) => {
      if (response.request().method() !== "POST") return;
      if (!/\/pack$/.test(new URL(response.url()).pathname)) return;
      sighting.status = response.status();
      sighting.cache = response.headers()["x-dropq-cache"] ?? null;
      sighting.retryAfter = response.headers()["retry-after"] ?? null;
    });
    await gotoHome(page, ctx.base);
    await waitForHydrated(page);
    await page.getByRole("button", { name: presetLabel("en", PRESET), exact: true }).click();
    await page.getByRole("button", { name: PACK_BUTTON }).click();
    await page.waitForURL(/\/pack\?session=/, { timeout: 60_000 });
    // Reload as soon as the URL changes, before the stream can be consumed.
    await page.reload({ waitUntil: "domcontentloaded" });
    try {
      await page.waitForSelector("section h3", { timeout: 90_000 });
    } catch (error) {
      const rateLimitVisible = await page
        .locator('[role="alert"]')
        .first()
        .textContent()
        .then((text) => Boolean(text?.trim()))
        .catch(() => false);
      const cause = error instanceof Error ? error.message.split("\n")[0]! : String(error);
      throw new Error(
        `I4 roots-gt-la/en: ${cause}; last pack status=${sighting.status ?? "none"} Retry-After=${sighting.retryAfter ?? "absent"} X-DropQ-Cache=${sighting.cache ?? "absent"} rate-limit UI=${rateLimitVisible ? "yes" : "no"}`,
      );
    }
    const latest = await readLatest(page, ctx.base);
    if (latest.plans.length !== 2) acc.fail(`after the reload the pack has ${latest.plans.length} plans`);
    const slots = new Set(latest.plans.flatMap((plan) => plan.items.map((item) => item.slot)));
    if (slots.size !== 4) acc.fail(`after the reload the pack covers ${slots.size} slots`);
    acc.pass();
  } catch (error) {
    acc.fail(error instanceof Error ? error.message.split("\n")[0]! : String(error));
  } finally {
    await context?.close();
  }
  acc.finish(ctx.recorder, Date.now() - started);
}

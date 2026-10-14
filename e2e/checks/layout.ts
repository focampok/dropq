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
  loadPreset,
  readLatest,
  expandTagToggles,
  scrollThrough,
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
    const preset = presetLabel("en", PRESET);
    const presetHit = await tabUntil(page, (info) => info.text === preset);
    if (!presetHit) acc.fail("Tab never reached a preset button");
    else if (!presetHit.hasRing) acc.fail("the preset button has no visible focus ring");
    // Enter operates the preset (it fills the seeds). The button is server-rendered, so
    // Tab can reach it before React has hydrated and attached the handler, and a key
    // press inside that window is dropped by the browser with nothing to retry it. Wait
    // for the bundle to settle and verify the effect instead of assuming the first press
    // landed: the check is about Enter filling the anchors, not about a race.
    if (presetHit) {
      const filled = async () => (await page.locator("#anchor-0").inputValue()).trim().length > 0;
      await page.keyboard.press("Enter");
      if (!(await filled())) {
        await page.waitForLoadState("networkidle").catch(() => undefined);
        await page.keyboard.press("Enter");
      }
      if (!(await filled())) acc.fail("Enter on a preset button did not fill the anchors");
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

async function checkI4(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("I4", "A reload during streaming leaves the session usable", "free");
  let context: BrowserContext | null = null;
  try {
    context = await newContext(ctx);
    const page = await context.newPage();
    await gotoHome(page, ctx.base);
    await page.getByRole("button", { name: presetLabel("en", PRESET), exact: true }).click();
    await page.getByRole("button", { name: PACK_BUTTON }).click();
    await page.waitForURL(/\/pack\?session=/, { timeout: 60_000 });
    // Reload as soon as the URL changes, before the stream can be consumed.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("section h3", { timeout: 90_000 });
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

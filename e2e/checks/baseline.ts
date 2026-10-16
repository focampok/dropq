/**
 * F7-1..F7-4: LLM-only vs Qloo baseline comparison.
 *
 * Preset path must be a stored-row hit (`X-DropQ-Cache: hit`) so Gemini/Qloo spend is
 * zero. The live/custom path is exercised with a mocked baseline response in both
 * profiles; prod never builds a live baseline.
 */
import type { BrowserContext, Page, Route } from "playwright";
import { Acc, type Ctx } from "../lib/ctx";
import { VIEWPORTS, nextForwarded } from "../lib/harness";
import { dict, presetLabel } from "../lib/app";
import {
  DONE,
  gotoHome,
  isHydrated,
  loadPreset,
  setLocaleCookie,
  waitForHydrated,
  waitForStreamDone,
  watchConsole,
} from "../lib/page";

const PACK_BUTTON = /Pack the night|Armar la noche/;
const PRESET = "roots-gt-la";
const HYDRATION_DELAY_MS = 2_500;

const MOCK_PAYLOAD = {
  cardsSig: "mock",
  locale: "en",
  llmItems: [
    { slot: "watch", name: "Mock Show" },
    { slot: "listen", name: "Mock Artist" },
    { slot: "wear", name: "Mock Brand" },
    { slot: "do", name: "Mock Venue" },
  ],
  verification: [
    {
      slot: "watch",
      status: "verified",
      resolvedEntityId: "e1",
      resolvedName: "Mock Show",
      inPack: true,
    },
    {
      slot: "listen",
      status: "not_verifiable",
      resolvedEntityId: null,
      resolvedName: null,
      inPack: false,
    },
    {
      slot: "wear",
      status: "verified",
      resolvedEntityId: "e3",
      resolvedName: "Mock Brand",
      inPack: false,
    },
    {
      slot: "do",
      status: "not_verifiable",
      resolvedEntityId: null,
      resolvedName: null,
      inPack: false,
    },
  ],
  source: "llm",
  summary: { verified: 2, inPack: 1 },
};

export async function runBaselineChecks(ctx: Ctx): Promise<void> {
  await checkF71(ctx);
  await checkF72(ctx);
  await checkF73(ctx);
  await checkF74(ctx);
}

async function openPresetPack(
  ctx: Ctx,
  locale: "en" | "es",
  viewport: { width: number; height: number } = { width: 1280, height: 800 },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await ctx.browser.newContext({
    viewport,
    extraHTTPHeaders: { "x-forwarded-for": nextForwarded() },
  });
  await setLocaleCookie(context, ctx.base, locale);
  const page = await context.newPage();
  await gotoHome(page, ctx.base);
  await loadPreset(page, ctx.base, presetLabel(locale, PRESET), PACK_BUTTON, {
    requireCacheHit: ctx.profile === "prod",
    where: `F7 ${locale}`,
  });
  await waitForStreamDone(page);
  await page.waitForSelector(DONE, { state: "attached", timeout: 30_000 });
  return { context, page };
}

async function checkF71(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("F7-1", "Baseline compare button is present and inert until hydrated", "free");
  let seed: BrowserContext | null = null;
  let context: BrowserContext | null = null;
  try {
    seed = await ctx.browser.newContext({
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { "x-forwarded-for": nextForwarded() },
    });
    await setLocaleCookie(seed, ctx.base, "en");
    const seedPage = await seed.newPage();
    await gotoHome(seedPage, ctx.base);
    await loadPreset(seedPage, ctx.base, presetLabel("en", PRESET), PACK_BUTTON, {
      requireCacheHit: ctx.profile === "prod",
      where: "F7-1 seed",
    });
    await waitForStreamDone(seedPage);
    const packUrl = seedPage.url();
    const cookies = await seed.cookies();
    await seed.close();
    seed = null;

    context = await ctx.browser.newContext({
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { "x-forwarded-for": nextForwarded() },
    });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.route("**/_next/static/chunks/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, HYDRATION_DELAY_MS));
      await route.continue();
    });
    await page.goto(packUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // Check before any long wait: delayed chunks must still leave controls inert.
    if (await isHydrated(page)) {
      acc.fail("the pack page reported hydrated while chunks were still held back");
    }
    const button = page.locator("[data-baseline-compare]");
    await button.waitFor({ state: "attached", timeout: 10_000 });
    if (await isHydrated(page)) {
      acc.fail("hydration completed before the compare button could be asserted inert");
    }
    if (!(await button.isDisabled().catch(() => false))) {
      acc.fail("the compare button is enabled before hydration");
    }
    await waitForHydrated(page);
    await page.waitForSelector(DONE, { state: "attached", timeout: 60_000 }).catch(() => undefined);
    // After hydration the button stays disabled until the pack payload is present.
    await page.waitForFunction(
      () => {
        const el = document.querySelector("[data-baseline-compare]") as HTMLButtonElement | null;
        return Boolean(el && !el.disabled);
      },
      undefined,
      { timeout: 60_000 },
    );
    const label = (await button.textContent())?.trim() ?? "";
    if (label !== dict("en").pack.baselineCompare) {
      acc.fail(`button label "${label}" ≠ "${dict("en").pack.baselineCompare}"`);
    }
    acc.pass();
  } catch (error) {
    acc.fail(error instanceof Error ? error.message.split("\n")[0]! : String(error));
  } finally {
    await seed?.close();
    await context?.close();
  }
  acc.finish(ctx.recorder, Date.now() - started);
}

async function checkF72(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc(
    "F7-2",
    "Preset baseline shows both columns from a cache hit with zero spend",
    "free",
  );
  let context: BrowserContext | null = null;
  try {
    const opened = await openPresetPack(ctx, "en");
    context = opened.context;
    const page = opened.page;
    const geminiBefore = ctx.budget.gemini;
    const qlooBefore = ctx.budget.qloo;

    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/pack\/baseline$/.test(new URL(response.url()).pathname),
      { timeout: 30_000 },
    );
    await page.locator("[data-baseline-compare]").click();
    const response = await responsePromise;
    const cache = response.headers()["x-dropq-cache"] ?? "";
    if (cache !== "hit") {
      acc.fail(`expected X-DropQ-Cache: hit, got "${cache || "missing"}" (status ${response.status()})`);
    }
    if (response.status() !== 200) {
      acc.fail(`baseline status ${response.status()}`);
    }
    await page.waitForSelector("[data-baseline-summary]", { timeout: 15_000 });
    const summary = (await page.locator("[data-baseline-summary]").textContent())?.trim() ?? "";
    if (!/\d of 4/.test(summary)) acc.fail(`summary line missing counts: "${summary}"`);
    const llmCol = page.getByRole("heading", { name: dict("en").pack.baselineColumnLlm });
    const qlooCol = page.getByRole("heading", { name: dict("en").pack.baselineColumnQloo });
    if ((await llmCol.count()) === 0) acc.fail("LLM only column missing");
    if ((await qlooCol.count()) === 0) acc.fail("With Qloo column missing");
    const slots = await page.locator("[data-baseline-slot]").count();
    if (slots !== 4) acc.fail(`expected 4 LLM slots, got ${slots}`);
    const statuses = await page.locator("[data-status]").count();
    if (statuses < 4) acc.fail(`expected status chips on every slot, got ${statuses}`);
    if (ctx.budget.gemini !== geminiBefore || ctx.budget.qloo !== qlooBefore) {
      acc.fail(
        `spend moved on preset baseline hit (gemini ${geminiBefore}->${ctx.budget.gemini}, qloo ${qlooBefore}->${ctx.budget.qloo})`,
      );
    }
    acc.note(`cache=${cache}; summary="${summary}"`);
    acc.pass();
  } catch (error) {
    acc.fail(error instanceof Error ? error.message.split("\n")[0]! : String(error));
  } finally {
    await context?.close();
  }
  acc.finish(ctx.recorder, Date.now() - started);
}

async function checkF73(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("F7-3", "Custom/live baseline path renders from a mocked response", "free");
  let context: BrowserContext | null = null;
  try {
    const opened = await openPresetPack(ctx, "en");
    context = opened.context;
    const page = opened.page;
    const handler = async (route: Route): Promise<void> => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "X-DropQ-Cache": "miss" },
        body: JSON.stringify(MOCK_PAYLOAD),
      });
    };
    await context.route("**/api/session/*/pack/baseline", handler);
    await page.locator("[data-baseline-compare]").click();
    await page.waitForSelector("[data-baseline-summary]", { timeout: 15_000 });
    const summary = (await page.locator("[data-baseline-summary]").textContent())?.trim() ?? "";
    const expected = dict("en")
      .pack.baselineSummary.replace("{verified}", "2")
      .replace("{inPack}", "1");
    if (summary !== expected) acc.fail(`mocked summary "${summary}" ≠ "${expected}"`);
    if ((await page.locator('[data-status="verified"]').count()) < 1) {
      acc.fail("verified chip missing on mocked payload");
    }
    if ((await page.locator('[data-status="not_verifiable"]').count()) < 1) {
      acc.fail("not-verifiable chip missing on mocked payload");
    }
    if ((await page.locator('[data-in-pack="yes"]').count()) < 1) {
      acc.fail("also-in-pack chip missing on mocked payload");
    }
    const resultCache = await page.locator("[data-baseline-result]").getAttribute("data-cache");
    if (resultCache !== "miss") acc.note(`data-cache=${resultCache ?? "null"} (mocked miss expected)`);
    acc.pass();
  } catch (error) {
    acc.fail(error instanceof Error ? error.message.split("\n")[0]! : String(error));
  } finally {
    await context?.close();
  }
  acc.finish(ctx.recorder, Date.now() - started);
}

async function checkF74(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("F7-4", "Baseline EN/ES copy, axe, mobile layout, no console errors", "free");
  let AxeBuilder: typeof import("@axe-core/playwright").default | null = null;
  try {
    AxeBuilder = (await import("@axe-core/playwright")).default;
  } catch {
    acc.note("axe-not-installed: skipping axe portion");
  }

  for (const locale of ["en", "es"] as const) {
    let context: BrowserContext | null = null;
    try {
      context = await ctx.browser.newContext({
        viewport: { width: VIEWPORTS[1]!.width, height: VIEWPORTS[1]!.height },
        extraHTTPHeaders: { "x-forwarded-for": nextForwarded() },
      });
      await setLocaleCookie(context, ctx.base, locale);
      const page = await context.newPage();
      const issues = watchConsole(page);
      await gotoHome(page, ctx.base);
      await loadPreset(page, ctx.base, presetLabel(locale, PRESET), PACK_BUTTON, {
        requireCacheHit: ctx.profile === "prod",
        where: `F7-4 ${locale}`,
      });
      await waitForStreamDone(page);
      await page.waitForSelector(DONE, { state: "attached", timeout: 30_000 });
      const d = dict(locale);
      const button = page.locator("[data-baseline-compare]");
      const label = (await button.textContent())?.trim() ?? "";
      if (label !== d.pack.baselineCompare) {
        acc.fail(`${locale}: button "${label}" ≠ "${d.pack.baselineCompare}"`);
      }
      await button.click();
      await page.waitForSelector("[data-baseline-summary]", { timeout: 30_000 });
      const honest = (await page.locator("[data-baseline-panel]").textContent()) ?? "";
      if (!honest.includes(d.pack.baselineHonest)) {
        acc.fail(`${locale}: honest copy missing`);
      }
      if (!honest.includes(d.pack.baselineColumnLlm) || !honest.includes(d.pack.baselineColumnQloo)) {
        acc.fail(`${locale}: column headings missing`);
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      if (overflow) acc.fail(`${locale}: horizontal scroll on mobile baseline panel`);
      const consoleNoise = [...issues.consoleErrors, ...issues.pageErrors];
      if (consoleNoise.length > 0) {
        acc.fail(`${locale}: console errors ${consoleNoise.slice(0, 3).join(" | ")}`);
      }
      if (AxeBuilder) {
        let results: Awaited<ReturnType<InstanceType<typeof AxeBuilder>["analyze"]>> | null = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            results = await new AxeBuilder({ page }).analyze();
            break;
          } catch {
            await page.waitForTimeout(500);
          }
        }
        if (!results) {
          acc.fail(`${locale}: axe run failed`);
        } else {
          const serious = results.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          if (serious.length > 0) {
            acc.fail(
              `${locale}: axe ${serious.map((v) => `${v.id}(${v.impact})`).join(", ")}`,
            );
          } else {
            acc.note(`${locale}: axe 0 serious/critical`);
          }
        }
      }
      acc.pass();
    } catch (error) {
      acc.fail(`${locale}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    } finally {
      await context?.close();
    }
  }
  acc.finish(ctx.recorder, Date.now() - started);
}

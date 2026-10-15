/**
 * H1–H2: the EN|ES toggle keeps the same cards, swaps strings and narration, and spends
 * no Qloo; the `dropq_lang` cookie persists. `prod-safe`, `free` (cached preset loads).
 */
import type { BrowserContext } from "playwright";
import { Acc, type Ctx } from "../lib/ctx";
import { nextForwarded } from "../lib/harness";
import { dict, presetLabel } from "../lib/app";
import { gotoHome, loadPreset, readLatest, scrape, waitForHydrated, waitForStreamDone, type CardDom } from "../lib/page";

const PACK_BUTTON = /Pack the night|Armar la noche/;
const PRESET = "roots-gt-la";

function slotMap(locale: "en" | "es", cards: CardDom[]): Record<string, string> {
  const slots = dict(locale).slots as Record<string, string>;
  const out: Record<string, string> = {};
  for (const card of cards) {
    const key = Object.entries(slots).find(([, value]) => value === card.slot)?.[0];
    if (key) out[key] = card.name;
  }
  return out;
}

export async function runLanguageChecks(ctx: Ctx): Promise<void> {
  await checkH1(ctx);
  await checkH2(ctx);
}

async function checkH1(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("H1", "EN|ES keeps the cards, swaps strings, spends no Qloo", "free");
  let context: BrowserContext | null = null;
  try {
    context = await ctx.browser.newContext({
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { "x-forwarded-for": nextForwarded() },
    });
    const page = await context.newPage();
    await gotoHome(page, ctx.base);
    await loadPreset(page, ctx.base, presetLabel("en", PRESET), PACK_BUTTON);
    await waitForStreamDone(page);
    const before = await scrape(page);
    const beforeSeries = before.map((section) => section.cards);
    const beforeNames = slotMap("en", before.flatMap((section) => section.cards));
    const beforeNarration = before[0]?.narrativeText ?? "";

    const local = ctx.profile === "local";
    const qlooBefore = local ? await ctx.qlooBuiltSince(ctx.runStart) : 0;

    const group = page.getByRole("group", { name: /Language|Idioma/ });
    await group.getByRole("button", { name: "ES", exact: true }).click();
    await page.waitForFunction(
      (previous) => {
        const element = document.querySelector("[data-narrative-text]");
        return Boolean(element && element.textContent !== previous && (element.textContent ?? "").trim().length > 0);
      },
      beforeNarration,
      { timeout: 30_000 },
    );
    await waitForStreamDone(page);
    const after = await scrape(page);
    const afterNames = slotMap("es", after.flatMap((section) => section.cards));

    if (JSON.stringify(beforeNames) !== JSON.stringify(afterNames)) {
      acc.fail(`the cards changed on toggle: ${JSON.stringify(beforeNames)} -> ${JSON.stringify(afterNames)}`);
    }
    if (afterNames.watch === undefined || Object.keys(afterNames).length !== 4) {
      acc.fail("the ES view did not show four slots");
    }
    const afterNarration = after[0]?.narrativeText ?? "";
    if (afterNarration === beforeNarration) acc.fail("the narration text did not change with the language");
    const esLabel = dict("es").slots.do;
    if (!after.some((section) => section.cards.some((card) => card.slot === esLabel))) {
      acc.fail(`the UI strings did not switch to Spanish (no "${esLabel}" slot)`);
    }
    // Cross-check against the app's own per-language row.
    const latest = await readLatest(page, ctx.base);
    if (!Array.isArray(latest?.plans)) {
      const rateLimitVisible = await page
        .locator('[role="alert"]')
        .first()
        .textContent()
        .then((text) => Boolean(text?.trim()))
        .catch(() => false);
      acc.fail(
        `packs/latest after toggle had no plans (rate-limit UI=${rateLimitVisible ? "yes" : "no"}; body keys=${Object.keys(latest ?? {}).join(",") || "none"})`,
      );
      acc.finish(ctx.recorder, Date.now() - started);
      return;
    }
    const apiNames = new Map<string, string>(
      latest.plans.flatMap((plan) => plan.items.map((item) => [String(item.slot), item.name] as [string, string])),
    );
    for (const [slot, name] of Object.entries(afterNames)) {
      if (apiNames.has(slot) && apiNames.get(slot) !== name) {
        acc.fail(`rendered ${slot} "${name}" differs from the stored row "${apiNames.get(slot)}"`);
      }
    }
    if (local) {
      const qlooAfter = await ctx.qlooBuiltSince(ctx.runStart);
      if (qlooAfter !== qlooBefore) acc.fail(`Qloo build count moved ${qlooBefore} -> ${qlooAfter} on toggle`);
    } else {
      acc.note("prod profile: Qloo counters are not observable");
    }
    void beforeSeries;
    acc.pass();
  } catch (error) {
    acc.fail(error instanceof Error ? error.message.split("\n")[0]! : String(error));
  } finally {
    await context?.close();
  }
  acc.finish(ctx.recorder, Date.now() - started);
}

async function checkH2(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("H2", "dropq_lang persists and the first visit is English", "free");
  let context: BrowserContext | null = null;
  try {
    context = await ctx.browser.newContext({
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { "x-forwarded-for": nextForwarded() },
    });
    const page = await context.newPage();
    await gotoHome(page, ctx.base);
    await waitForHydrated(page);
    const group = page.getByRole("group", { name: /Language|Idioma/ });
    const enPressed = await group.getByRole("button", { name: "EN", exact: true }).getAttribute("aria-pressed");
    if (enPressed !== "true") acc.fail(`the first visit is not English (EN aria-pressed=${enPressed})`);

    await group.getByRole("button", { name: "ES", exact: true }).click();
    await page.waitForTimeout(500);
    const cookies = await context.cookies();
    const lang = cookies.find((cookie) => cookie.name === "dropq_lang")?.value;
    if (lang !== "es") acc.fail(`after choosing ES the cookie is ${lang ?? "(absent)"}`);

    await page.reload({ waitUntil: "domcontentloaded" });
    const esPressed = await group.getByRole("button", { name: "ES", exact: true }).getAttribute("aria-pressed");
    if (esPressed !== "true") acc.fail(`after reload ES is no longer selected (aria-pressed=${esPressed})`);
    acc.pass();
  } catch (error) {
    acc.fail(error instanceof Error ? error.message.split("\n")[0]! : String(error));
  } finally {
    await context?.close();
  }
  acc.finish(ctx.recorder, Date.now() - started);
}

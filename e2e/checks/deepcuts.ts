/**
 * E1–E2: Deep cuts round-trip. Local-only: the first toggle builds the deep bridge with
 * live Qloo calls (the presets warm only the default snapshot).
 *
 * The refine response has no numeric Qloo field, so "zero Qloo" is asserted from the
 * app's own statement that the hop-1 and anchor steps were skipped as a `snapshot`
 * restore, plus a flat cumulative `geminiCalls`.
 */
import type { BrowserContext, Locator, Page } from "playwright";
import { Acc, type Ctx } from "../lib/ctx";
import { BudgetAbort, installFetchTee, nextForwarded, readTee, teeNdjson, type StreamEvent, type TeeEntry } from "../lib/harness";
import { dict, presetLabel } from "../lib/app";
import {
  gotoHome,
  loadPreset,
  readLatest,
  scrape,
  setLocaleCookie,
  waitForStreamDone,
  type Latest,
} from "../lib/page";

const PRESETS = ["roots-gt-la", "latin-tour-houston", "fandom-con-nyc"] as const;
const PACK_BUTTON = /Pack the night|Armar la noche/;
const SLOT_ORDER = ["watch", "listen", "wear", "do"] as const;

function refineEntries(entries: TeeEntry[]): TeeEntry[] {
  return entries.filter((entry) => /\/pack\/refine$/.test(entry.url));
}

function deepButton(page: Page): Locator {
  return page.locator("button[aria-pressed]").filter({ hasText: /Deep cuts|Descubrir más/ }).first();
}

async function toggle(page: Page): Promise<StreamEvent[]> {
  const button = deepButton(page);
  const before = await button.getAttribute("aria-pressed");
  const want = before === "true" ? "false" : "true";
  const seen = refineEntries(await readTee(page)).length;
  await button.click();
  const deadline = Date.now() + 120_000;
  for (;;) {
    if ((await button.getAttribute("aria-pressed")) === want) break;
    if (Date.now() > deadline) throw new Error(`deep cuts never reached ${want}`);
    await page.waitForTimeout(200);
  }
  const teeDeadline = Date.now() + 10_000;
  for (;;) {
    const entries = refineEntries(await readTee(page));
    if (entries.length > seen) return teeNdjson(entries[entries.length - 1]);
    if (Date.now() > teeDeadline) return [];
    await page.waitForTimeout(150);
  }
}

function idsOf(latest: Latest, label: "A" | "B"): string[] {
  return (latest.plans.find((plan) => plan.label === label)?.items ?? []).map((item) => item.entityId);
}

function narrativeOf(latest: Latest, label: "A" | "B"): string {
  return latest.plans.find((plan) => plan.label === label)?.narrative?.trim() ?? "";
}

function templateFor(locale: "en" | "es", latest: Latest): string {
  const planB = latest.plans.find((plan) => plan.label === "B");
  const names = SLOT_ORDER.map((slot) => planB?.items.find((item) => item.slot === slot)?.name).filter(
    (name): name is string => Boolean(name),
  );
  return dict(locale).pack.narrativeTemplate.replace("{names}", names.join(", "));
}

function snapshotRestore(events: StreamEvent[]): boolean {
  return (
    events.some((event) => event.step === "insights_hop1" && event.status === "skipped" && event.detail === "snapshot") &&
    events.some((event) => event.step === "pick_bridge_anchors" && event.status === "skipped" && event.detail === "snapshot")
  );
}

async function bridgeText(page: Page, locale: "en" | "es"): Promise<string> {
  return page
    .evaluate((label) => {
      const section = [...document.querySelectorAll("section[aria-label]")].find(
        (element) => element.getAttribute("aria-label") === label,
      );
      return section?.querySelector("[data-narrative-text]")?.textContent ?? "";
    }, dict(locale).plans.B)
    .catch(() => "");
}

/** Poll until the Bridge narrative changes, returning the first repaint and its badge. */
async function observeBridge(
  page: Page,
  previous: string,
  locale: "en" | "es",
): Promise<{ text: string; badge: boolean } | null> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const observation = await page
      .evaluate((label) => {
        const section = [...document.querySelectorAll("section[aria-label]")].find(
          (element) => element.getAttribute("aria-label") === label,
        );
        if (!section) return null;
        return {
          text: section.querySelector("[data-narrative-text]")?.textContent ?? "",
          badge: Boolean(section.querySelector("[data-ai-badge]")),
        };
      }, dict(locale).plans.B)
      .catch(() => null);
    if (observation && observation.text && observation.text !== previous) return observation;
    if (Date.now() > deadline) return null;
    await page.waitForTimeout(150);
  }
}

export async function runDeepCutsChecks(ctx: Ctx): Promise<void> {
  const e1 = new Acc("E1", "Deep cuts on/off/on preserves A and restores B exactly", "qloo");
  const e2 = new Acc("E2", "Bridge shows the template first; Plan A's narration is untouched", "gemini");
  for (const preset of PRESETS) {
    try {
      await onePreset(ctx, e1, e2, preset);
    } catch (error) {
      if (error instanceof BudgetAbort) throw error;
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      e1.fail(`${preset}: ${message}`);
      e2.fail(`${preset}: ${message}`);
    }
    if (ctx.profile === "local") {
      await ctx.qlooBuiltSince(ctx.runStart).then((n) => ctx.budget.setQlooBuilt(n)).catch(() => undefined);
    }
  }
  e1.finish(ctx.recorder, 0);
  e2.finish(ctx.recorder, 0);
}

async function onePreset(ctx: Ctx, e1: Acc, e2: Acc, preset: string): Promise<void> {
  const locale = "en" as const;
  let context: BrowserContext | null = null;
  try {
    context = await ctx.browser.newContext({
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { "x-forwarded-for": nextForwarded() },
    });
    await setLocaleCookie(context, ctx.base, locale);
    await installFetchTee(context);
    const page = await context.newPage();
    await gotoHome(page, ctx.base);
    await loadPreset(page, ctx.base, presetLabel(locale, preset), PACK_BUTTON);
    await waitForStreamDone(page);

    const initial = await readLatest(page, ctx.base);
    const defaultA = idsOf(initial, "A");
    const defaultB = idsOf(initial, "B");
    const narrationA0 = narrativeOf(initial, "A");

    const states: { mode: string; a: string[]; b: string[]; snapshot: boolean; narrationA: string }[] = [];
    let firstObservation: { text: string; badge: boolean } | null = null;
    let firstWasLive = false;
    let firstTemplate = "";

    const modes = ["deep_cuts", "default", "deep_cuts"] as const;
    for (let index = 0; index < modes.length; index += 1) {
      const before = await bridgeText(page, locale);
      // Start observing before the click so the template window is not missed.
      const observer = index === 0 ? observeBridge(page, before, locale) : null;
      const events = await toggle(page);
      const snapshot = snapshotRestore(events);
      ctx.budget.noteGeminiCumulative(events.at(-1)?.geminiCalls ?? 0);

      const latest = await readLatest(page, ctx.base);
      states.push({
        mode: modes[index]!,
        a: idsOf(latest, "A"),
        b: idsOf(latest, "B"),
        snapshot,
        narrationA: narrativeOf(latest, "A"),
      });

      if (observer) {
        firstObservation = await observer;
        firstWasLive = !snapshot;
        // The template belongs to the *new* (deep) bridge, not the default one.
        firstTemplate = templateFor(locale, latest);
      }
      if (!snapshot) {
        ctx.budget.addQlooOther(ctx.refineQlooEstimate);
        ctx.log(`    ${preset}: toggle ${index + 1} rebuilt the deep bridge live (+${ctx.refineQlooEstimate} est Qloo)`);
      }
    }

    // E1 assertions.
    for (const state of states) {
      if (state.a.join("|") !== defaultA.join("|")) {
        e1.fail(`${preset}: Plan A changed after ${state.mode} (${state.a.join(",")})`);
      }
      const shared = state.a.filter((id) => state.b.includes(id));
      if (shared.length > 0) e1.fail(`${preset}: after ${state.mode} the plans share ${shared.length} id(s)`);
    }
    const [on1, off, on2] = states;
    if (on1 && !on1.snapshot && on1.b.join("|") === defaultB.join("|")) {
      e1.fail(`${preset}: deep cuts did not change the Bridge`);
    }
    if (off) {
      if (off.b.join("|") !== defaultB.join("|")) e1.fail(`${preset}: "off" did not restore the default Bridge exactly`);
      if (!off.snapshot) e1.fail(`${preset}: restoring the default did not reuse the snapshot (Qloo spent)`);
    }
    if (on2) {
      if (!on2.snapshot) e1.fail(`${preset}: the second deep-cuts did not reuse the snapshot (Qloo spent)`);
      if (on1 && on2.b.join("|") !== on1.b.join("|")) e1.fail(`${preset}: the second deep-cuts differs from the first`);
    }
    e1.pass();
    e1.note(`${preset}: snapshot restore per toggle = ${states.map((s) => (s.snapshot ? "yes" : "no")).join("/")}`);

    // E2 assertions.
    for (const state of states) {
      if (state.narrationA !== narrationA0) e2.fail(`${preset}: Plan A's narration changed after a toggle`);
    }
    const finalLatest = await readLatest(page, ctx.base);
    const bridge = (await scrape(page)).find((section) => section.label === dict(locale).plans.B);
    const apiLlm = finalLatest.plans.find((plan) => plan.label === "B")?.llm?.narrative === "llm";
    if (bridge && bridge.badge.present !== apiLlm) {
      e2.fail(`${preset}: Bridge badge=${bridge.badge.present} but stored narration is ${apiLlm ? "llm" : "template"}`);
    }
    if (firstObservation && firstWasLive) {
      if (firstObservation.badge) {
        e2.fail(`${preset}: the first Bridge repaint after the live toggle already had the AI badge`);
      } else if (firstObservation.text.trim() !== firstTemplate.trim()) {
        e2.note(`${preset}: first Bridge repaint was not the exact template (${firstObservation.text.slice(0, 60)})`);
      }
    }
    e2.pass();
  } finally {
    await context?.close();
  }
}

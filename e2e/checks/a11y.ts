/**
 * K1: axe-core on the loaded pack, both languages. Non-gating: violations are reported,
 * never failed on. `prod-safe`, `free` (cached preset loads).
 */
import type { BrowserContext } from "playwright";
import { Acc, type Ctx } from "../lib/ctx";
import { nextForwarded } from "../lib/harness";
import { presetLabel } from "../lib/app";
import { gotoHome, loadPreset, scrollThrough, setLocaleCookie, waitForStreamDone } from "../lib/page";

export async function runA11yChecks(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("K1", "axe-core violations on the loaded pack (non-gating)", "free");
  let AxeBuilder: typeof import("@axe-core/playwright").default;
  try {
    AxeBuilder = (await import("@axe-core/playwright")).default;
  } catch {
    acc.finishSkipped(ctx.recorder, "axe-not-installed");
    return;
  }
  for (const locale of ["en", "es"] as const) {
    let context: BrowserContext | null = null;
    try {
      context = await ctx.browser.newContext({
        viewport: { width: 1280, height: 800 },
        extraHTTPHeaders: { "x-forwarded-for": nextForwarded() },
      });
      await setLocaleCookie(context, ctx.base, locale);
      const page = await context.newPage();
      await gotoHome(page, ctx.base);
      await loadPreset(page, ctx.base, presetLabel(locale, "roots-gt-la"), /Pack the night|Armar la noche/);
      await waitForStreamDone(page);
      await scrollThrough(page);
      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations.filter(
        (violation) => violation.impact === "serious" || violation.impact === "critical",
      );
      acc.note(
        `${locale}: ${results.violations.length} violation(s), ${serious.length} serious/critical${
          serious.length > 0 ? ` (${serious.map((violation) => violation.id).join(", ")})` : ""
        }`,
      );
    } catch (error) {
      acc.note(`${locale}: axe run failed (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
    } finally {
      await context?.close();
    }
  }
  acc.pass();
  acc.finish(ctx.recorder, Date.now() - started);
}

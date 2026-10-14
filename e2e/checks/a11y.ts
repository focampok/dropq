/**
 * K1: axe-core on the loaded pack, both languages. Non-gating: violations are reported,
 * never failed on. `prod-safe`, `free` (cached preset loads).
 */
import type { BrowserContext } from "playwright";
import { Acc, type Ctx } from "../lib/ctx";
import { VIEWPORTS, nextForwarded } from "../lib/harness";
import { presetLabel } from "../lib/app";
import { gotoHome, loadPreset, scrollThrough, setLocaleCookie, waitForStreamDone } from "../lib/page";

/** How many failing nodes per rule are listed in the report before summarising. */
const NODE_REPORT_LIMIT = 10;

export async function runA11yChecks(ctx: Ctx): Promise<void> {
  const started = Date.now();
  const acc = new Acc("K1", "axe-core violations on the loaded pack, both viewports (non-gating)", "free");
  let AxeBuilder: typeof import("@axe-core/playwright").default;
  try {
    AxeBuilder = (await import("@axe-core/playwright")).default;
  } catch {
    acc.finishSkipped(ctx.recorder, "axe-not-installed");
    return;
  }
  for (const viewport of VIEWPORTS) {
    for (const locale of ["en", "es"] as const) {
      const where = `${locale}@${viewport.name}`;
      let context: BrowserContext | null = null;
      try {
        context = await ctx.browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
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
          `${where}: ${results.violations.length} violation(s), ${serious.length} serious/critical${
            serious.length > 0
              ? ` (${serious.map((violation) => `${violation.id} x${violation.nodes.length}`).join(", ")})`
              : ""
          }`,
        );
        // Name what is left, so a passing check still shows the minor findings.
        for (const violation of results.violations) {
          if (serious.includes(violation)) continue;
          acc.note(`${where}: ${violation.impact ?? "unknown"} ${violation.id} x${violation.nodes.length}`);
        }
        // Name the failing nodes so a regression points at the element, not just
        // at the rule. Selectors and measured ratios only: no page text.
        for (const violation of serious) {
          for (const node of violation.nodes.slice(0, NODE_REPORT_LIMIT)) {
            const ratio = node.any[0]?.data?.contrastRatio ?? null;
            const expected = node.any[0]?.data?.expectedContrastRatio ?? null;
            acc.note(
              `${where}: ${violation.id} ${node.target.join(" ")} ratio=${ratio ?? "?"} need=${expected ?? "?"}`,
            );
          }
          if (violation.nodes.length > NODE_REPORT_LIMIT) {
            acc.note(`${where}: ${violation.id} ... ${violation.nodes.length - NODE_REPORT_LIMIT} more node(s)`);
          }
        }
      } catch (error) {
        acc.note(
          `${where}: axe run failed (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
        );
      } finally {
        await context?.close();
      }
    }
  }
  acc.pass();
  acc.finish(ctx.recorder, Date.now() - started);
}

/**
 * Drives the built app in a real browser: one pass per preset at 1280 px and 390 px.
 *
 * It starts `next start` on its own port, waits for /api/health, and then per preset
 * loads the pack, screenshots both widths, checks for horizontal scroll at 390 px,
 * counts images that failed to load, toggles EN | ES, and toggles Deep cuts twice.
 * Console errors and page errors are collected and printed.
 *
 *   pnpm verify:ui
 *
 * Chromium comes from whatever is already in the Playwright cache. If the revision
 * the installed Playwright expects is missing, the newest cached one is used instead;
 * the script never downloads a browser.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const PORT = Number(process.env.UI_PORT ?? 3311);
const BASE = process.env.UI_BASE_URL ?? `http://localhost:${PORT}`;
const DONE = 'li[data-step="done"][data-state="done"]';
const READY_MS = 120_000;

/**
 * The pack and refine routes allow 4 requests per minute and 20 per hour per forwarded
 * IP. Toggling the language re-runs the pack, so a preset can spend more than four in
 * a minute; each verified step therefore presents its own forwarded IP, which is what
 * the limiter models anyway (one bucket per visitor).
 */
let forwarded = 0;
function nextForwarded(): string {
  forwarded += 1;
  return `10.9.${Math.floor(forwarded / 250)}.${forwarded % 250}`;
}

function cachedChromium(): string | undefined {
  const root = path.join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root)
    .filter((name) => name.startsWith("chromium-"))
    .sort()
    .reverse();
  for (const dir of dirs) {
    for (const candidate of [
      path.join(root, dir, "chrome-linux64", "chrome"),
      path.join(root, dir, "chrome-linux", "chrome"),
      path.join(root, dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function launchOptions(): { executablePath?: string } {
  const expected = chromium.executablePath();
  if (existsSync(expected)) return {};
  const fallback = cachedChromium();
  if (!fallback) return {};
  console.log(`Using the cached Chromium at revision ${path.basename(path.dirname(path.dirname(fallback)))}.`);
  return { executablePath: fallback };
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + READY_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`server did not answer on ${BASE}/api/health within ${READY_MS} ms`);
}

type Probe = {
  width: number;
  overflowing: boolean;
  brokenImages: number;
  totalImages: number;
  screenshots: string[];
};

async function scrollThrough(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(800);
}

async function imageReport(page: Page): Promise<{ broken: number; total: number }> {
  return page.evaluate(() => {
    const images = Array.from(document.images);
    return {
      total: images.length,
      broken: images.filter((image) => !(image.complete && image.naturalWidth > 0)).length,
    };
  });
}

async function measure(page: Page, name: string, width: number, errors: string[]): Promise<Probe> {
  await page.setViewportSize({ width, height: 900 });
  await scrollThrough(page);
  const overflowing = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  const images = await imageReport(page);
  const file = path.join("docs", "screenshots", `${name}-${width}.png`);
  await page.screenshot({ path: file, fullPage: true });
  if (errors.length > 0) {
    console.log(`  console errors so far: ${errors.slice(0, 3).join(" | ").slice(0, 300)}`);
  }
  return {
    width,
    overflowing,
    brokenImages: images.broken,
    totalImages: images.total,
    screenshots: [file],
  };
}

async function loadPreset(page: Page, presetLabel: string): Promise<number> {
  const started = Date.now();
  await page.getByRole("button", { name: presetLabel, exact: true }).click();
  await page.getByRole("button", { name: /Pack the night|Armar la noche/ }).click();
  await page.waitForURL(/\/pack\?session=/, { timeout: READY_MS });
  await page.waitForSelector(DONE, { timeout: READY_MS });
  return Date.now() - started;
}

function deepCutsButton(page: Page) {
  return page.locator("button[aria-pressed]").filter({ hasText: /Deep cuts|Descubrir más/ }).first();
}

/**
 * A streaming response reports its status as soon as the headers land, so waiting on
 * /pack/refine says nothing about when the pack is stored. The button only flips after
 * the client refetches, so poll the button itself.
 */
async function toggleDeepCuts(page: Page): Promise<string | null> {
  const button = deepCutsButton(page);
  const before = await button.getAttribute("aria-pressed");
  const expected = before === "true" ? "false" : "true";
  await button.click();
  const deadline = Date.now() + READY_MS;
  for (;;) {
    if ((await button.getAttribute("aria-pressed")) === expected) return expected;
    if (Date.now() > deadline) throw new Error(`deep cuts never reached ${expected}`);
    await page.waitForTimeout(250);
  }
}

async function main(): Promise<void> {
  if (!existsSync(".next")) {
    console.log("No .next build found. Run `pnpm build` first.");
    process.exit(1);
  }
  await mkdir(path.join("docs", "screenshots"), { recursive: true });

  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  const consoleErrors: string[] = [];
  const httpErrors: string[] = [];
  const probes: Probe[] = [];
  const failures: string[] = [];

  try {
    server = spawn("pnpm", ["start", "-p", String(PORT)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      detached: true,
    });
    server.stdout?.on("data", () => undefined);
    server.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().split("\n")[0]?.trim();
      if (text) console.log(`  [server] ${text.slice(0, 200)}`);
    });
    await waitForServer();
    console.log(`App answering on ${BASE}`);

    browser = await chromium.launch(launchOptions());

    for (const preset of [
      { id: "roots-gt-la", label: "Roots GT → LA" },
      { id: "latin-tour-houston", label: "Latin tour → Houston" },
      { id: "fandom-con-nyc", label: "Anime con → NYC" },
    ]) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        extraHTTPHeaders: { "x-forwarded-for": nextForwarded() },
      });
      // Every pack-scope step gets a fresh forwarded IP so one preset never shares a bucket.
      const rotate = async () => {
        await context.setExtraHTTPHeaders({ "x-forwarded-for": nextForwarded() });
      };
      const page = await context.newPage();
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(`${preset.id}: ${message.text()}`);
      });
      page.on("pageerror", (error) => consoleErrors.push(`${preset.id}: pageerror ${error.message}`));
      page.on("response", (response) => {
        const url = new URL(response.url());
        if (url.pathname.includes("/pack")) {
          const forwardedHeader = response.request().headers()["x-forwarded-for"] ?? "(none)";
          console.log(`    ${response.request().method()} ${url.pathname} -> ${response.status()} xff=${forwardedHeader}`);
        }
        if (response.status() >= 400) {
          httpErrors.push(`${preset.id}: ${response.request().method()} ${url.pathname} -> ${response.status()}`);
        }
      });

      const before = consoleErrors.length;
      try {
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      const ms = await loadPreset(page, preset.label);
      console.log(`\n${preset.id}: pack stream done in ${ms} ms`);

      for (const width of [1280, 390]) {
        const probe = await measure(page, preset.id, width, consoleErrors.slice(before));
        probes.push(probe);
        console.log(
          `  ${width}px: horizontal scroll ${probe.overflowing ? "YES" : "no"}; broken images ${probe.brokenImages}/${probe.totalImages}`,
        );
        if (probe.overflowing) failures.push(`${preset.id} overflows at ${width}px`);
      }


      // EN -> ES -> EN, so the next preset starts from a clean language state.
      await page.setViewportSize({ width: 1280, height: 900 });
      await rotate?.();
      // Deep cuts twice: on, then off. The second run must restore the default bridge.
      await rotate();
      const on = await toggleDeepCuts(page);
      const off = await toggleDeepCuts(page);
      console.log(`  deep cuts toggled twice: ${on} then ${off}`);
      if (on !== "true" || off !== "false") failures.push(`${preset.id} deep cuts toggle did not round-trip`);

      const after = await measure(page, `${preset.id}-deepcuts`, 1280, consoleErrors.slice(before));
      probes.push(after);
      console.log(`  after deep cuts: broken images ${after.brokenImages}/${after.totalImages}`);

      await rotate();
      const group = page.getByRole("group", { name: /Idioma|Language/ });
      await group.getByRole("button", { name: "ES", exact: true }).click();
      await page.waitForTimeout(600);
      const spanish = await page.locator("li[data-step='done']").first().textContent();
      await group.getByRole("button", { name: "EN", exact: true }).click();
      await page.waitForTimeout(600);
      const english = await page.locator("li[data-step='done']").first().textContent();
      const swapped = spanish !== english;
      console.log(`  language toggle changed the step label: ${swapped ? "yes" : "no"}`);
      if (!swapped) failures.push(`${preset.id} language toggle did not change the text`);

      } catch (error) {
        const where = `${page.url()}`;
        const text = await page
          .evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 240))
          .catch(() => "(no body)");
        failures.push(`${preset.id}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        console.log(`  ${preset.id} failed at ${where}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
        console.log(`  page text: ${text}`);
      } finally {
        await context.close();
      }
    }
  } catch (error) {
    failures.push(`run failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await browser?.close();
    if (server?.pid) {
      // next start runs under pnpm, so the whole group has to go.
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        server.kill("SIGTERM");
      }
    }
  }

  console.log("\n| preset screenshot | px | horizontal scroll | broken images |");
  console.log("| --- | --- | --- | --- |");
  for (const probe of probes) {
    console.log(`| ${probe.screenshots[0]} | ${probe.width} | ${probe.overflowing ? "yes" : "no"} | ${probe.brokenImages}/${probe.totalImages} |`);
  }
  console.log(`\nHTTP responses >= 400: ${httpErrors.length}`);
  for (const message of [...new Set(httpErrors)].slice(0, 12)) console.log(`  - ${message}`);
  console.log(`\nConsole errors: ${consoleErrors.length}`);
  for (const message of consoleErrors.slice(0, 10)) console.log(`  - ${message.slice(0, 200)}`);
  console.log(`\nFailures: ${failures.length}`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(failures.length > 0 || httpErrors.length > 0 || consoleErrors.length > 0 ? 1 : 0);
}

void main();

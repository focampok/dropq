/**
 * Browser flow helpers: load a preset or a custom pack, wait for the stream, scrape the
 * rendered pack and cross-read the app's own `/packs/latest` from the same cookie jar.
 */
import type { BrowserContext, Page } from "playwright";
import { PresetCacheMissError } from "./harness";

export const DONE = 'li[data-step="done"][data-state="done"]';
export const READY_MS = 120_000;

/** The app sets this on `<html>` from a client effect, once its handlers are attached. */
export const HYDRATED = 'html[data-hydrated="true"]';

/**
 * The app renders its controls server-side and gates them until React has hydrated, so a
 * tap in the unhydrated window cannot become a native form submit. Every check that clicks
 * or types must wait for that gate to lift instead of racing it: on a slow connection the
 * gap is seconds, not milliseconds.
 */
export async function waitForHydrated(page: Page, timeout = READY_MS): Promise<void> {
  try {
    await page.waitForSelector(HYDRATED, { timeout, state: "attached" });
  } catch {
    throw new Error(
      `the page never reported data-hydrated="true" on <html> within ${timeout} ms; the app is not interactive`,
    );
  }
}

/** Whether the app has already reported itself interactive. */
export async function isHydrated(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.dataset.hydrated === "true");
}

/** Waiting for the 503-quota body is not an error; the live path can legitimately hit it. */
export type LatestPlanItem = {
  slot: "watch" | "listen" | "wear" | "do";
  hop: number;
  entityId: string;
  name: string;
  type: string;
  imageUrl: string | null;
  affinityScore: number | null;
  explain: string | null;
  evidence: Record<string, unknown> | null;
  confidence: "high" | "medium" | "low" | "unverified";
  provenance: "qloo" | "mock";
};

export type LatestPlan = {
  label: "A" | "B";
  axis: "root" | "bridge";
  narrative: string | null;
  coverage: Record<string, unknown> | null;
  llm: {
    anchors: string;
    anchorSource: string;
    narrative: string;
    headline: string;
    provider: string | null;
    offReason: string | null;
    failures: string[];
    calls?: number;
    modelUsed?: { anchors: string | null; narrative: string | null };
  } | null;
  items: LatestPlanItem[];
};

export type Latest = {
  city: string;
  eventKind: string | null;
  locale?: string;
  anchors: { rawText: string; resolvedName: string | null; type: string; entityId: string | null }[];
  plans: LatestPlan[];
};

export type CardDom = {
  slot: string;
  name: string;
  chosenForCity: boolean;
  prose: string | null;
  image: { kind: "img" | "placeholder" | "none"; loaded: boolean; complete: boolean };
  rows: { label: string; value: string; tags: string[]; hasToggle: boolean; toggleLabel: string | null }[];
};

export type SectionDom = {
  label: string;
  narrativeText: string | null;
  badge: { present: boolean; ownElement: boolean; glued: boolean; leftMargin: number };
  cards: CardDom[];
};

export async function setLocaleCookie(context: BrowserContext, base: string, locale: "en" | "es"): Promise<void> {
  const { hostname, protocol } = new URL(base);
  await context.addCookies([
    {
      name: "dropq_lang",
      value: locale,
      domain: hostname,
      path: "/",
      httpOnly: false,
      secure: protocol === "https:",
      sameSite: "Lax",
    },
  ]);
}

export async function gotoHome(page: Page, base: string): Promise<void> {
  await page.goto(base, { waitUntil: "domcontentloaded" });
}

/** Load a cached preset: click the preset, then pack. Returns ms from the pack click. */
export async function loadPreset(
  page: Page,
  base: string,
  presetLabel: string,
  packLabel: RegExp | string,
  options: { requireCacheHit?: boolean; where?: string } = {},
): Promise<number> {
  await gotoHome(page, base);
  await waitForHydrated(page);
  await page.getByRole("button", { name: presetLabel, exact: true }).click();
  const started = Date.now();
  const packResponse = options.requireCacheHit
    ? page.waitForResponse(
        (response) => response.request().method() === "POST" && /\/pack$/.test(new URL(response.url()).pathname),
        { timeout: READY_MS },
      )
    : null;
  await page.getByRole("button", { name: packLabel }).click();
  if (packResponse) {
    // A preset that is not in the stored cache would trigger a live build, which spends
    // Qloo and Gemini against production. The app marks a served row with this header, so
    // its absence is the signal to stop the whole suite before anything is generated.
    const response = await packResponse;
    const cache = response.headers()["x-dropq-cache"];
    if (cache !== "hit") {
      throw new PresetCacheMissError(
        `${options.where ?? presetLabel}: the pack response was not served from the stored cache (X-DropQ-Cache: ${cache ?? "absent"})`,
      );
    }
  }
  await page.waitForURL(/\/pack\?session=/, { timeout: READY_MS });
  await waitForCards(page);
  return Date.now() - started;
}

/** Load a custom pack by typing the seeds and choosing the city + kind. */
export async function loadCustom(
  page: Page,
  base: string,
  input: { seeds: string[]; cityLabel: string; kindLabel: string; packLabel: RegExp | string },
): Promise<number> {
  await gotoHome(page, base);
  await waitForHydrated(page);
  for (let index = 0; index < input.seeds.length; index += 1) {
    await page.locator(`#anchor-${index}`).fill(input.seeds[index]!);
  }
  await page.getByRole("button", { name: input.cityLabel, exact: true }).click();
  await page.getByRole("button", { name: input.kindLabel, exact: true }).click();
  const started = Date.now();
  await page.getByRole("button", { name: input.packLabel }).click();
  await page.waitForURL(/\/pack\?session=/, { timeout: READY_MS });
  await waitForCards(page);
  return Date.now() - started;
}

export async function waitForCards(page: Page): Promise<void> {
  await page.waitForSelector("section h3", { timeout: READY_MS });
}

export async function waitForStreamDone(page: Page): Promise<void> {
  await page.waitForSelector(DONE, { timeout: READY_MS });
}

export function sessionIdOf(page: Page): string {
  const url = new URL(page.url());
  return url.searchParams.get("session") ?? "";
}

/** Read the app's own latest-pack payload through the browser's own cookies. */
export async function readLatest(page: Page, base: string): Promise<Latest> {
  const sessionId = sessionIdOf(page);
  const response = await page.request.get(`${base}/api/session/${sessionId}/packs/latest`);
  return (await response.json()) as Latest;
}

/** Lazy images only report `naturalWidth` once scrolled into view. */
export async function scrollThrough(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(500);
}

/**
 * Hotlinked card images are lazy and may resolve or fail slowly. Wait until every
 * `<img>` has settled (`complete` is true once loaded or errored; a failed one is then
 * swapped for the typed placeholder) before judging the image state.
 */
export async function waitForImages(page: Page, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = await page
      .evaluate(() => [...document.images].filter((image) => !image.complete).length)
      .catch(() => 0);
    if (pending === 0 || Date.now() > deadline) break;
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(400);
}

export async function expandTagToggles(page: Page): Promise<void> {
  const toggles = page.locator("[data-tags-toggle]");
  const count = await toggles.count();
  for (let index = 0; index < count; index += 1) {
    const toggle = toggles.nth(index);
    const label = (await toggle.textContent())?.trim() ?? "";
    if (/^\+/.test(label) || / más$/.test(label)) {
      await toggle.click().catch(() => undefined);
    }
  }
}

/**
 * One round-trip into the page: every plan section, its narration and badge, and each
 * card's slot, name, prose, image state and evidence rows (dt/dd pairs with their tags).
 */
export async function scrape(page: Page): Promise<SectionDom[]> {
  return page.evaluate(() => {
    const sections = [...document.querySelectorAll("section[aria-label]")];
    return sections.map((section) => {
      const narrative = section.querySelector("[data-narrative-text]");
      const badge = section.querySelector("[data-ai-badge]");
      const narrativeText = narrative?.textContent ?? null;
      const badgeText = badge?.textContent?.trim() ?? "";
      const badgeStyle = badge instanceof HTMLElement ? getComputedStyle(badge) : null;
      const container = section.querySelector("div.space-y-3");
      const cards = container ? [...container.children] : [];
      return {
        label: section.getAttribute("aria-label") ?? "",
        narrativeText,
        badge: {
          present: Boolean(badge),
          ownElement: Boolean(badge && narrative && badge !== narrative && !narrative.contains(badge)),
          glued: Boolean(badgeText && narrativeText && narrativeText.includes(badgeText)),
          leftMargin: badgeStyle ? Number.parseFloat(badgeStyle.marginLeft) || 0 : 0,
        },
        cards: cards.map((card) => {
          const h3 = card.querySelector("h3");
          const slot = card.querySelector("p")?.textContent?.trim() ?? "";
          const chosenForCity = [...card.querySelectorAll("p")].some((p) =>
            /^(chosen for the city|elegido por la ciudad)$/i.test(p.textContent?.trim() ?? ""),
          );
          const proseEl = card.querySelector("p.text-sm.leading-relaxed");
          const img = card.querySelector("img");
          const placeholder = card.querySelector('[role="img"]');
          const rows = [...card.querySelectorAll("dl > dt")].map((dt) => {
            const dd = dt.nextElementSibling as HTMLElement | null;
            const toggle = dd?.querySelector("[data-tags-toggle]") ?? null;
            const value = dd?.textContent?.trim() ?? "";
            // Tags are the comma-joined text before the toggle control.
            const raw = toggle ? value.replace(toggle.textContent ?? "", "").trim() : value;
            const tags = raw
              .split(/,\s*/)
              .map((tag) => tag.trim())
              .filter(Boolean);
            return {
              label: dt.textContent?.trim() ?? "",
              value,
              tags,
              hasToggle: Boolean(toggle),
              toggleLabel: toggle?.textContent?.trim() ?? null,
            };
          });
          return {
            slot: slot.split("\n")[0]?.trim() ?? "",
            name: h3?.textContent?.trim() ?? "",
            chosenForCity,
            prose: proseEl?.textContent?.trim() ?? null,
            image: img
              ? {
                  kind: "img" as const,
                  loaded: (img as HTMLImageElement).naturalWidth > 0,
                  complete: (img as HTMLImageElement).complete,
                }
              : placeholder
                ? { kind: "placeholder" as const, loaded: true, complete: true }
                : { kind: "none" as const, loaded: false, complete: false },
            rows,
          };
        }),
      };
    });
  });
}

export type ConsoleIssues = {
  consoleErrors: string[];
  pageErrors: string[];
  /** Failed requests that never produced a response and were not mocked on purpose. */
  failedRequests: string[];
  all: { consoleErrors: string[]; pageErrors: string[]; failures: string[] };
};

/**
 * A response the browser aborts *after* receiving it is common for the app's own NDJSON
 * streams (no `Content-Length`, the client stops reading). Such a request did receive a
 * response, so it is not a failed request; only requests that never got one are recorded.
 */
export function watchConsole(page: Page, mocked: string[] = []): ConsoleIssues {
  const issues: ConsoleIssues = { consoleErrors: [], pageErrors: [], failedRequests: [], all: { consoleErrors: [], pageErrors: [], failures: [] } };
  const responded = new Set<string>();
  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = message.text().slice(0, 300);
      issues.consoleErrors.push(text);
      issues.all.consoleErrors.push(text);
    }
  });
  page.on("pageerror", (error) => {
    const text = String(error.message).slice(0, 300);
    issues.pageErrors.push(text);
    issues.all.pageErrors.push(text);
  });
  page.on("response", (response) => responded.add(`${response.request().method()} ${response.url()}`));
  page.on("requestfailed", (request) => {
    const key = `${request.method()} ${request.url()}`;
    const failure = request.failure();
    const line = `${request.method()} ${request.url().slice(0, 200)} ${failure?.errorText ?? ""}`;
    issues.all.failures.push(line);
    if (responded.has(key)) return;
    if (mocked.some((pattern) => request.url().includes(pattern))) return;
    if (failure?.errorText === "net::ERR_ABORTED" && /\/api\/session\/[^/]+\/pack(\/refine)?$/.test(request.url())) return;
    issues.failedRequests.push(line);
  });
  return issues;
}

/** Dictionary lookup for the language a scenario runs in. */
export function sentenceCount(text: string): number {
  return text
    .split(/[.!?…]+/)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

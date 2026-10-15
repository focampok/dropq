/**
 * Shared infrastructure for the end-to-end suite (`pnpm e2e`).
 *
 * Nothing here reads `.env`: the app is started as a child process with the ambient
 * environment, and every assertion reads the app's own API/stream/DB data. Secrets are
 * never logged, captured or screenshotted (the UI never shows one and devtools are not
 * opened).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export type Profile = "local" | "prod";
export type Cost = "free" | "qloo" | "gemini";
export type Status = "PASS" | "FAIL" | "SKIP";

export type CheckResult = {
  id: string;
  name: string;
  profile: Profile;
  cost: Cost;
  status: Status;
  reason?: string;
  ms: number;
  screenshots: string[];
  details: string[];
};

export const E2E_ROOT = path.join("docs", "e2e");
export const SHOT_ROOT = path.join(E2E_ROOT, "screenshots");
export const TRACE_ROOT = path.join(E2E_ROOT, "traces");

export const VIEWPORTS = [
  { name: "1280x800", width: 1280, height: 800 },
  { name: "390x844", width: 390, height: 844 },
] as const;

/** Gemini hard cap for one suite run (the brief allows 45). */
export const GEMINI_BUDGET = 45;
/** Qloo hard cap for one suite run (the brief allows 70). */
export const QLOO_BUDGET = 70;

/** Thrown when a cost counter would pass the budget; the runner aborts costly work. */
export class BudgetAbort extends Error {
  constructor(readonly kind: Cost, readonly spent: number, readonly max: number) {
    super(`${kind} budget exceeded: ${spent} > ${max}`);
    this.name = "BudgetAbort";
  }
}

/**
 * A preset that is not in the stored pack cache. In the prod profile that is fatal: the
 * next click would make the deployment run a paid live build, so the suite stops instead
 * of continuing to generate.
 */
export class PresetCacheMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresetCacheMissError";
  }
}

/**
 * Counters that abort the run, not just report.
 *
 * Gemini is read from the app's own stream (`done` carries the process-cumulative
 * `geminiCalls`, so the delta between two calls is exact). No API exposes a live Qloo
 * counter, so Qloo is read from the app's own recorded build count
 * (`PackCache.qlooCalls`, summed over rows built during this run) plus a documented,
 * conservative estimate for bridge refinements, which are not persisted to that table.
 */
export class Budget {
  gemini = 0;
  /** Qloo build calls the app recorded since the run started (PackCache.qlooCalls). */
  qlooBuilt = 0;
  /** Qloo calls only estimated (bridge refinements, which the app does not persist). */
  qlooOther = 0;
  private geminiCursor: number | null = null;

  get qloo(): number {
    return this.qlooBuilt + this.qlooOther;
  }

  /** Feed a cumulative `geminiCalls` reading from a stream; only the delta is charged. */
  noteGeminiCumulative(cumulative: number): number {
    if (!Number.isFinite(cumulative)) return 0;
    const before = this.geminiCursor;
    this.geminiCursor = cumulative;
    if (before === null) return 0;
    const delta = Math.max(0, cumulative - before);
    this.gemini += delta;
    return delta;
  }

  setQlooBuilt(n: number): void {
    this.qlooBuilt = Math.max(0, n);
    this.assert();
  }

  addQlooOther(n: number): void {
    this.qlooOther += Math.max(0, n);
    this.assert();
  }

  assert(): void {
    if (this.gemini > GEMINI_BUDGET) throw new BudgetAbort("gemini", this.gemini, GEMINI_BUDGET);
    if (this.qloo > QLOO_BUDGET) throw new BudgetAbort("qloo", this.qloo, QLOO_BUDGET);
  }

  summary(): string {
    return `gemini ${this.gemini}/${GEMINI_BUDGET}, qloo ${this.qloo}/${QLOO_BUDGET} (built ${this.qlooBuilt}, est ${this.qlooOther})`;
  }
}

/** Reuse the Chromium that already works for `pnpm verify:ui`; never download one. */
export function cachedChromium(): string | undefined {
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

export function launchOptions(): { executablePath?: string } {
  const expected = chromium.executablePath();
  if (existsSync(expected)) return {};
  const fallback = cachedChromium();
  return fallback ? { executablePath: fallback } : {};
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch(launchOptions());
}

let forwardedCounter = 0;
/**
 * A fresh forwarded IP per step, so the app's per-IP limits model distinct visitors.
 * Uses TEST-NET-2 (198.51.100.0/24), not RFC1918: a private address can look like a
 * mis-derived proxy hop on Railway and collapse every check into one shared bucket.
 */
export function nextForwarded(): string {
  forwardedCounter += 1;
  return `198.51.100.${1 + (forwardedCounter % 250)}`;
}

// ---------------------------------------------------------------------------
// Local server lifecycle (local profile only)
// ---------------------------------------------------------------------------

export const LOCAL_PORT = 3311;

export type Server = { base: string; stop: () => void };

async function waitForHealth(base: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const response = await fetch(`${base}/api/health`);
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not answer on ${base}/api/health`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export async function startLocalServer(): Promise<Server> {
  const base = `http://localhost:${LOCAL_PORT}`;
  let server: ChildProcess | null = spawn("pnpm", ["start", "-p", String(LOCAL_PORT)], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      // The app aborts its own Gemini calls past this cap, so the suite cannot overspend
      // even if a check's own counter is wrong.
      DROPQ_LLM_BUDGET: String(GEMINI_BUDGET),
    },
    detached: true,
  });
  server.stderr?.on("data", () => undefined);
  const stop = () => {
    if (!server?.pid) return;
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
    server = null;
  };
  try {
    await waitForHealth(base, 120_000);
  } catch (error) {
    stop();
    throw error;
  }
  return { base, stop };
}

// ---------------------------------------------------------------------------
// Minimal cookie-jar HTTP client (API-level checks)
// ---------------------------------------------------------------------------

export class ApiJar {
  private cookies = new Map<string, string>();
  readonly forwarded = nextForwarded();
  constructor(readonly base: string) {}

  private header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  ingest(response: Response): void {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const index = pair?.indexOf("=") ?? -1;
      if (index > 0) this.cookies.set(pair!.slice(0, index), pair!.slice(index + 1));
    }
  }

  rawCookies(): { name: string; value: string }[] {
    return [...this.cookies.entries()].map(([name, value]) => ({ name, value }));
  }

  async request(path: string, init: RequestInit & { body?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("x-forwarded-for", this.forwarded);
    const cookie = this.header();
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(`${this.base}${path}`, { ...init, headers, redirect: "manual" });
    this.ingest(response);
    return response;
  }

  async json<T>(path: string, init?: RequestInit & { body?: string }): Promise<{ status: number; body: T | null }> {
    const response = await this.request(path, init);
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as T) : null };
  }

  async stream(
    path: string,
    body: string,
  ): Promise<{ status: number; events: StreamEvent[]; ms: number; paintMs: number }> {
    const started = Date.now();
    const response = await this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const events: StreamEvent[] = [];
    let paintMs = 0;
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as StreamEvent;
          events.push(event);
          if (paintMs === 0 && event.step === "assemble" && event.status === "done") paintMs = Date.now() - started;
        }
      }
    }
    return { status: response.status, events, ms: Date.now() - started, paintMs: paintMs || Date.now() - started };
  }
}

export type StreamEvent = {
  step?: string;
  status?: string;
  detail?: string;
  packIds?: string[];
  cached?: boolean;
  geminiCalls?: number;
  llmFallback?: string;
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export class Recorder {
  readonly results: CheckResult[] = [];

  constructor(
    readonly profile: Profile,
    readonly base: string,
    private readonly log: (line: string) => void,
  ) {}

  record(result: CheckResult): void {
    this.results.push(result);
    const suffix = result.reason ? ` (${result.reason})` : "";
    this.log(`[${result.id}] ${result.status}${suffix} — ${result.name} [${result.ms} ms]`);
    for (const line of result.details) this.log(`      ${line}`);
  }
}

export function makeResult(input: {
  id: string;
  name: string;
  profile: Profile;
  cost: Cost;
  status: Status;
  reason?: string;
  ms: number;
  screenshots?: string[];
  details?: string[];
}): CheckResult {
  return {
    id: input.id,
    name: input.name,
    profile: input.profile,
    cost: input.cost,
    status: input.status,
    ...(input.reason ? { reason: input.reason } : {}),
    ms: input.ms,
    screenshots: input.screenshots ?? [],
    details: input.details ?? [],
  };
}

let screenshotSeq = 0;
/** Screenshots at both required viewports, saved plain (the UI shows no secrets). */
export async function screenshotBoth(page: Page, label: string): Promise<string[]> {
  await mkdir(SHOT_ROOT, { recursive: true });
  const saved: string[] = [];
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(120);
    const file = path.join(SHOT_ROOT, `${label}-${viewport.name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    saved.push(file);
  }
  screenshotSeq += 1;
  void screenshotSeq;
  return saved;
}

export async function saveTrace(context: BrowserContext, label: string): Promise<string | null> {
  try {
    await mkdir(TRACE_ROOT, { recursive: true });
    const file = path.join(TRACE_ROOT, `${label}.zip`);
    await context.tracing.stop({ path: file });
    return file;
  } catch {
    return null;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeText(file: string, value: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
}

// ---------------------------------------------------------------------------
// In-page fetch tee: read the app's own NDJSON bodies reliably
// ---------------------------------------------------------------------------

const TEE_GLOBAL = "__dropqE2E";

export type TeeEntry = { url: string; status: number; text: string };

/**
 * The browser aborts its own streaming responses right after reading them (no
 * `Content-Length`, the client stops), so Playwright cannot always retrieve the body
 * afterwards. Tearing `window.fetch` inside the page captures the bytes reliably because
 * the page owns the stream.
 */
export async function installFetchTee(context: BrowserContext): Promise<void> {
  await context.addInitScript((key: string) => {
    const store: { url: string; status: number; text: string }[] = [];
    const scope = window as unknown as Record<string, unknown>;
    scope[key] = store;
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await original(input, init);
      try {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        if (/\/pack(\/refine)?(\?|$)/.test(url)) {
          const clone = response.clone();
          clone
            .text()
            .then((text) => store.push({ url, status: response.status, text }))
            .catch(() => undefined);
        }
      } catch {
        /* ignore */
      }
      return response;
    };
  }, TEE_GLOBAL);
}

export async function readTee(page: Page): Promise<TeeEntry[]> {
  return page.evaluate(
    (key: string) => ((window as unknown as Record<string, unknown>)[key] as TeeEntry[] | undefined) ?? [],
    TEE_GLOBAL,
  );
}

/**
 * Wait until the tee holds at least `atLeast` matching entries and the newest one has
 * non-empty text. The in-page `clone.text()` resolves a tick after the stream ends, so a
 * read straight after the UI is done can still see an empty body.
 */
export async function waitForTee(
  page: Page,
  match: (entry: TeeEntry) => boolean,
  atLeast: number,
  timeoutMs = 15_000,
): Promise<TeeEntry | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = (await readTee(page)).filter(match);
    const newest = entries[entries.length - 1];
    if (entries.length >= atLeast && newest && newest.text.trim().length > 0) return newest;
    if (Date.now() > deadline) return newest;
    await page.waitForTimeout(150);
  }
}

export function teeNdjson(entry: TeeEntry | undefined): StreamEvent[] {
  if (!entry) return [];
  return entry.text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as StreamEvent;
      } catch {
        return {} as StreamEvent;
      }
    });
}

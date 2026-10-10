/**
 * Local end-to-end verification over HTTP with a cookie jar per visitor.
 *
 * It assumes the app is already running (`BASE_URL`, default http://localhost:3000)
 * and checks the pack invariants for all three presets, the Deep cuts round trip, the
 * session gate, the LLM coverage and the Qloo quota. It prints a table and exits
 * non-zero if any invariant fails.
 *
 *   pnpm verify:local
 *
 * The pack and refine routes allow 4 requests per minute and 20 per hour per forwarded
 * IP, and one preset spends four per run, so each step presents its own forwarded IP.
 * That is what the limiter models anyway: one bucket per visitor.
 */
import { placeTagExcluded } from "../src/lib/pack/assemble";
import { DEMO_PRESETS, type CityValue, type EventKind } from "../src/lib/presets";
import { STEP_IDS } from "../src/lib/i18n/types";

const BASE = process.env.BASE_URL?.trim() || "http://localhost:3000";

type Event = { step?: string; status?: string; detail?: string; packIds?: string[]; llmFallback?: string };

type Item = {
  slot: "watch" | "listen" | "wear" | "do";
  entityId: string;
  name: string;
  type: string;
  confidence: string;
  evidence: Record<string, unknown> | null;
};

type Plan = {
  label: "A" | "B";
  narrative: string | null;
  coverage: Record<string, unknown> | null;
  llm: { anchors: string; anchorSource: string; narrative: string; headline: string; provider: string | null; offReason: string | null; failures: string[] } | null;
  items: Item[];
};

type Latest = { city: string; eventKind: string | null; plans: Plan[] };

let forwarded = 0;
const runOctet = Math.floor(Math.random() * 240) + 1;
function nextForwarded(): string {
  forwarded += 1;
  // The octet is per process, so two runs in the same minute never share a bucket.
  return `10.4.${runOctet}.${forwarded % 250}`;
}

/** Minimal cookie jar: only what the app sets is sent back. */
class Jar {
  private cookies = new Map<string, string>();
  readonly forwarded = nextForwarded();

  private header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async request(path: string, init: RequestInit & { body?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("x-forwarded-for", this.forwarded);
    const cookie = this.header();
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const index = pair?.indexOf("=") ?? -1;
      if (index > 0) this.cookies.set(pair!.slice(0, index), pair!.slice(index + 1));
    }
    return response;
  }

  async json<T>(path: string, init?: RequestInit & { body?: string }): Promise<{ status: number; body: T | null }> {
    const response = await this.request(path, init);
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as T) : null };
  }

  /**
   * Reads a streamed NDJSON response to the end, timing two moments: the assemble step,
   * which is when the pack is stored and the UI can paint it without the narration, and
   * the end of the stream.
   */
  async stream(path: string, body: string): Promise<{ status: number; events: Event[]; headers: Headers; ms: number; paintMs: number }> {
    const started = Date.now();
    const response = await this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const events: Event[] = [];
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
          const event = JSON.parse(line) as Event;
          events.push(event);
          if (paintMs === 0 && event.step === "assemble" && event.status === "done") {
            paintMs = Date.now() - started;
          }
        }
      }
    }
    const ms = Date.now() - started;
    return { status: response.status, events, headers: response.headers, ms, paintMs: paintMs || ms };
  }
}

const LODGING = ["hotel", "lodging", "resort", "motel", "inn", "suites"];

type Result = {
  preset: string;
  slotsA: number;
  slotsB: number;
  watchTv: boolean;
  crossShared: number;
  doClean: boolean;
  stepsOk: boolean;
  firstPaintMs: number;
  streamMs: number;
  llm: string;
  anchorSource: string;
  narrative: string;
  narration: { source: string; failures: string[] }[];
  failures: string[];
};

function checkPlan(plan: Plan, failures: string[], where: string): void {
  const slots = new Set(plan.items.map((item) => item.slot));
  if (plan.items.length !== 4 || slots.size !== 4) {
    failures.push(`${where}: expected 4 slots, saw ${plan.items.length} items in ${slots.size} slots`);
  }
  for (const item of plan.items) {
    if (!item.entityId?.trim()) failures.push(`${where}: ${item.slot} has no entityId`);
    if (!item.name?.trim()) failures.push(`${where}: ${item.slot} has no name`);
  }
  for (const item of plan.items.filter((entry) => entry.slot === "do")) {
    const tags = [item.name, ...((item.evidence?.hitTags as string[] | undefined) ?? [])].join(" ").toLowerCase();
    if (LODGING.some((word) => tags.includes(word)) || placeTagExcluded(item.name)) {
      failures.push(`${where}: do looks like lodging (${item.name})`);
    }
  }
  for (const item of plan.items.filter((entry) => entry.slot === "watch")) {
    if (!item.type.includes("tv_show")) failures.push(`${where}: watch is not a tv_show (${item.type})`);
  }
}

function stepOrder(events: Event[]): string[] {
  return events.filter((event) => event.step).map((event) => `${event.step}:${event.status}`);
}

function ordered(events: Event[], failures: string[], where: string): boolean {
  let cursor = -1;
  for (const step of STEP_IDS) {
    const index = events.findIndex((event, position) => position > cursor && event.step === step && event.status !== "pending");
    if (index < 0) {
      failures.push(`${where}: step ${step} never appeared`);
      return false;
    }
    cursor = index;
  }
  const done = events.filter((event) => event.step === "done" && event.status === "done");
  if (done.length !== 1) failures.push(`${where}: expected one done, saw ${done.length}`);
  const error = events.find((event) => event.step === "error");
  if (error) failures.push(`${where}: stream reported an error (${error.detail})`);
  return !error;
}

async function runPreset(preset: (typeof DEMO_PRESETS)[number]): Promise<Result> {
  const jar = new Jar();
  const failures: string[] = [];
  const name = preset.id;

  const session = await jar.json<{ id?: string }>("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ city: preset.city as CityValue, eventKind: preset.eventKind as EventKind, locale: "en" }),
  });
  const sessionId = session.body?.id;
  if (!sessionId) throw new Error(`${name}: no session id (status ${session.status})`);

  await jar.json(`/api/session/${sessionId}/seeds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seeds: preset.seeds.map((seed) => ({ rawText: seed.rawText, source: "preset" })) }),
  });

  const pack = await jar.stream(`/api/session/${sessionId}/pack`, "{}");
  const stepsOk = ordered(pack.events, failures, `${name} pack`);
  const latest = await jar.json<Latest>(`/api/session/${sessionId}/packs/latest`);
  const plans = latest.body?.plans ?? [];
  const planA = plans.find((plan) => plan.label === "A");
  const planB = plans.find((plan) => plan.label === "B");
  if (!planA || !planB) throw new Error(`${name}: expected plans A and B`);

  checkPlan(planA, failures, `${name} A`);
  checkPlan(planB, failures, `${name} B`);

  const idsA = new Set(planA.items.map((item) => item.entityId));
  const crossShared = planB.items.filter((item) => idsA.has(item.entityId)).length;
  if (crossShared > 0) failures.push(`${name}: ${crossShared} ids appear in both plans`);

  // One entry per plan narrative: the pack writes both plans, each toggle rewrites B.
  const narration: { source: string; failures: string[] }[] = [
    { source: planA.llm?.narrative ?? "?", failures: planA.llm?.failures ?? [] },
    { source: planB.llm?.narrative ?? "?", failures: planB.llm?.failures ?? [] },
  ];

  const defaultBridge = planB.items.map((item) => item.entityId);
  const rootIdsBefore = planA.items.map((item) => item.entityId);
  const defaultNarrative = planB.narrative;

  // Deep cuts on -> off -> on. Only the first toggle may touch Qloo.
  const toggles: { mode: "deep_cuts" | "default"; events: Event[]; items: string[]; roots: string[]; snapshot: boolean }[] = [];
  for (const mode of ["deep_cuts", "default", "deep_cuts"] as const) {
    const refine = await jar.stream(`/api/session/${sessionId}/pack/refine`, JSON.stringify({ mode }));
    const after = (await jar.json<Latest>(`/api/session/${sessionId}/packs/latest`)).body;
    const bridge = after?.plans.find((plan) => plan.label === "B");
    const root = after?.plans.find((plan) => plan.label === "A");
    const snapshot =
      refine.events.some((event) => event.step === "insights_hop1" && event.status === "skipped" && event.detail === "snapshot") &&
      refine.events.some((event) => event.step === "pick_bridge_anchors" && event.status === "skipped" && event.detail === "snapshot");
    narration.push({
      source: bridge?.llm?.narrative ?? "?",
      failures: bridge?.llm?.failures ?? [],
    });
    toggles.push({
      mode,
      events: refine.events,
      items: bridge?.items.map((item) => item.entityId) ?? [],
      roots: root?.items.map((item) => item.entityId) ?? [],
      snapshot,
    });
    if (refine.status !== 200) failures.push(`${name}: refine ${mode} returned ${refine.status}`);
  }

  const [on1, off, on2] = toggles;
  if (on1 && !on1.snapshot && on1.items.join("|") === defaultBridge.join("|")) {
    failures.push(`${name}: deep cuts bridge is identical to the default`);
  }
  if (off) {
    if (off.items.join("|") !== defaultBridge.join("|")) failures.push(`${name}: off did not restore the default bridge`);
    if (off.roots.join("|") !== rootIdsBefore.join("|")) failures.push(`${name}: off changed plan A`);
  }
  if (on2) {
    if (!on2.snapshot) failures.push(`${name}: the second deep cuts did not reuse the snapshot`);
    if (on1 && on2.items.join("|") !== on1.items.join("|")) failures.push(`${name}: the second deep cuts differs from the first`);
    if (on2.roots.join("|") !== rootIdsBefore.join("|")) failures.push(`${name}: plan A changed on the second deep cuts`);
  }
  if (off && !off.snapshot) failures.push(`${name}: restoring the default did not reuse the snapshot`);

  // A visitor without the session cookie must not reach this pack.
  const stranger = new Jar();
  const denied = await stranger.request(`/api/session/${sessionId}/packs/latest`);
  await denied.body?.cancel();
  if (denied.status !== 403) failures.push(`${name}: a second cookie jar got ${denied.status}, expected 403`);

  const llm = planB.llm;
  const health = await jar.json<{ quota: { remaining?: number; blocked: boolean }; llm: string }>("/api/health");

  return {
    preset: name,
    slotsA: planA.items.length,
    slotsB: planB.items.length,
    watchTv: planA.items.concat(planB.items).filter((item) => item.slot === "watch").every((item) => item.type.includes("tv_show")),
    crossShared,
    doClean: !failures.some((failure) => failure.includes("lodging")),
    stepsOk,
    firstPaintMs: pack.paintMs,
    streamMs: pack.ms,
    llm: `${health.body?.llm ?? "?"}/${llm?.narrative ?? "?"}${llm?.provider ? `:${llm.provider}` : ""}`,
    anchorSource: planB.llm?.anchorSource ?? "(none)",
    narrative: planB.llm?.narrative ?? "(none)",
    narration,
    failures,
  };
}

async function main(): Promise<void> {
  try {
    const health = await fetch(`${BASE}/api/health`);
    await health.body?.cancel();
    if (!health.ok) throw new Error(`health ${health.status}`);
  } catch (error) {
    console.log(`App is not answering on ${BASE}: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  const results: Result[] = [];
  for (const preset of DEMO_PRESETS) {
    try {
      results.push(await runPreset(preset));
    } catch (error) {
      results.push({
        preset: preset.id,
        slotsA: 0,
        slotsB: 0,
        watchTv: false,
        crossShared: 0,
        doClean: false,
        stepsOk: false,
        firstPaintMs: 0,
        streamMs: 0,
        llm: "?",
        anchorSource: "?",
        narrative: "?",
        narration: [],
        failures: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  const medians = (values: number[]) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
  };

  console.log("| preset | slots A/B | watch tv | shared ids | do clean | steps | first paint | stream end | llm | anchor | narrative |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of results) {
    console.log(
      `| ${row.preset} | ${row.slotsA}/${row.slotsB} | ${row.watchTv ? "yes" : "NO"} | ${row.crossShared} | ${row.doClean ? "yes" : "NO"} | ${row.stepsOk ? "ok" : "FAIL"} | ${row.firstPaintMs} ms | ${row.streamMs} ms | ${row.llm} | ${row.anchorSource} | ${row.narrative} |`,
    );
  }
  console.log(
    `\nFirst paint median (pack stored, narration not waited for): ${medians(results.map((row) => row.firstPaintMs))} ms`,
  );
  console.log(`Stream-end median (includes narration): ${medians(results.map((row) => row.streamMs))} ms`);

  const health = await fetch(`${BASE}/api/health`).then((response) => response.json()).catch(() => null);
  console.log(`Qloo quota remaining from the last response headers: ${JSON.stringify(health?.quota ?? "unknown")}`);

  const narrations = results.flatMap((row) => row.narration);
  const fellBack = narrations.filter((entry) => entry.source === "template");
  const codes = [...new Set(fellBack.flatMap((entry) => entry.failures))];
  const rate = narrations.length === 0 ? 0 : Math.round((fellBack.length / narrations.length) * 1000) / 10;
  console.log(
    `Narrations: ${narrations.length}; fell back to the template: ${fellBack.length} (${rate}%); codes: ${codes.join(", ") || "none"}`,
  );
  for (const row of results) {
    const rowCodes = [...new Set(row.narration.flatMap((entry) => entry.failures))];
    console.log(`  ${row.preset}: ${row.narration.map((entry) => entry.source).join(",")} ${rowCodes.length ? `[${rowCodes.join(",")}]` : ""}`);
  }

  const allFailures = results.flatMap((row) => row.failures);
  const deepCutsEvidence = results.map((row) => `${row.preset}:${row.anchorSource}/${row.narrative}`);
  console.log(`\nCoverage: ${deepCutsEvidence.join(", ")}`);
  console.log(`Failures: ${allFailures.length}`);
  for (const failure of allFailures) console.log(`  - ${failure}`);
  process.exit(allFailures.length > 0 ? 1 : 0);
}

void main();

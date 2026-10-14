/**
 * Warm orchestration: which rows to rebuild, what each row ends as, and the bounded
 * `--until-ok` rounds.
 *
 * Everything the outside world provides — the clock, the sleep, the builders, the
 * stored rows, the provider budgets — arrives through `WarmDeps`, so every rule below
 * is exercised by tests with no database, no network and no model.
 *
 * Two rules matter more than the rest:
 * - A row ends in exactly one of `cached` / `kept` / `template` / `failed`, and it
 *   always carries `reason=` and `attempts=`. An LLM outage is not a row failure: the
 *   row still builds with the template (or is kept) and the reason says why.
 * - A stored `llm` row is never replaced by a `template` one; that lives in
 *   `pack/cache.ts` and this module only reads the grade it reports back.
 */
import { PINNED_PRESETS } from "../src/lib/pipeline/config";
import { QLOO_CUSTOM_RESERVE } from "../src/lib/config";
import { packNarrationGrade, type NarrationGrade, type PackCachePayload } from "../src/lib/pack/cache";

export const LOCALES = ["en", "es"] as const;
export type WarmLocale = (typeof LOCALES)[number];

/** Builds per row before giving up. Only useful while the LLM can still answer. */
export const WARM_ATTEMPTS = 3;
export const WARM_RETRY_PAUSE_MS = 2_000;

export const WARM_MAX_ROUNDS_DEFAULT = 4;
export const WARM_PAUSE_S_DEFAULT = 300;
/** Never hammer: the shortest pause `--until-ok` accepts, even after a failed round. */
export const WARM_MIN_PAUSE_S = 60;

/** Where a row ended. Exactly one of these is reported per row. */
export type WarmStatus = "cached" | "kept" | "template" | "failed";

/**
 * Why it ended there. Never a URL, a host or a value.
 * - `ok` — a new llm row was written.
 * - `quota_daily` / `quota_minute` — the chain could not answer for that quota reason.
 * - `timeout` — the model was too slow (per-attempt cap or deadline).
 * - `llm_error` — any other LLM failure, or the LLM being off.
 * - `qloo_guard` — the Qloo guard or reserve stopped the build before any call.
 * - `qloo_error` — Qloo failed the build.
 * - `build_error` — the pipeline threw for another reason.
 */
export type WarmReason =
  | "ok"
  | "quota_daily"
  | "quota_minute"
  | "timeout"
  | "llm_error"
  | "qloo_guard"
  | "qloo_error"
  | "build_error";

export type WarmTarget = {
  presetId: (typeof PINNED_PRESETS)[number]["id"];
  locale: WarmLocale;
};

export type WarmRow = {
  presetId: string;
  locale: WarmLocale;
  status: WarmStatus;
  reason: WarmReason;
  narration: { A: string; B: string };
  modelUsed: { A: string | null; B: string | null };
  geminiCalls: number;
  qlooCalls: number;
  /** Builds attempted for this row, including the one that produced the payload. */
  attempts: number;
  ms: number;
};

export type WarmBuild =
  | { ok: true; payload: PackCachePayload; qlooCalls: number }
  | { ok: false; reason: Extract<WarmReason, "build_error" | "qloo_guard" | "qloo_error"> };

export type WarmDeps = {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Build one pack; never throws, and reports why when it cannot. */
  build(target: WarmTarget): Promise<WarmBuild>;
  /** The stored cache row for this target, or null when there is none. */
  readStored(target: WarmTarget): Promise<{ grade: NarrationGrade } | null>;
  /** Grade-aware write: `wrote` is false when the stored row is at least as good. */
  write(input: {
    target: WarmTarget;
    payload: PackCachePayload;
    qlooCalls: number;
  }): Promise<{ wrote: boolean; grade: NarrationGrade }>;
  llm(): { configured: boolean; disabled: boolean };
  geminiCalls(): number;
  qlooCalls(): number;
  qlooQuota(): { blocked: boolean; remaining?: number };
  /** Every model skipped, at least one of them out of daily quota. */
  dailyExhaustion(): { exhausted: boolean; resetMs: number | null };
  log(line: string): void;
};

export type WarmStop =
  | "all_llm"
  | "single_round"
  | "quota_daily"
  | "qloo_reserve"
  | "max_rounds";

export type WarmRunOptions = {
  untilOk: boolean;
  maxRounds: number;
  pauseMs: number;
};

export type WarmRunResult = {
  rows: WarmRow[];
  rounds: number;
  stop: WarmStop;
  /** Only for `quota_daily`: the instant the daily quota resets, in epoch ms. */
  resetMs: number | null;
};

/** Every preset × language the warm must visit (6 rows). */
export function warmTargets(): WarmTarget[] {
  const out: WarmTarget[] = [];
  for (const preset of PINNED_PRESETS) {
    for (const locale of LOCALES) {
      out.push({ presetId: preset.id, locale });
    }
  }
  return out;
}

export class WarmArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WarmArgError";
  }
}

/**
 * `--only <preset>[:en|:es]`, repeatable, also accepting a comma-separated list.
 * No selector means the whole matrix.
 */
export function selectTargets(selectors: readonly string[]): WarmTarget[] {
  const all = warmTargets();
  if (selectors.length === 0) return all;
  const chosen: WarmTarget[] = [];
  for (const raw of selectors) {
    const [presetId, locale, ...rest] = raw.split(":").map((part) => part.trim());
    if (!presetId || rest.length > 0) throw new WarmArgError(`--only expects <preset>[:en|:es], got "${raw}"`);
    const preset = PINNED_PRESETS.find((row) => row.id === presetId);
    if (!preset) {
      throw new WarmArgError(
        `unknown preset "${presetId}"; known: ${PINNED_PRESETS.map((row) => row.id).join(", ")}`,
      );
    }
    const locales = locale === undefined ? LOCALES : LOCALES.filter((code) => code === locale);
    if (locales.length === 0) throw new WarmArgError(`--only expects :en or :es, got ":${locale}"`);
    for (const code of locales) {
      if (!chosen.some((row) => row.presetId === presetId && row.locale === code)) {
        chosen.push({ presetId: preset.id, locale: code });
      }
    }
  }
  return chosen;
}

/** `--only a,b --only c:es` → every selector the operator wrote, in order. */
export function onlySelectors(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--only") continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new WarmArgError("--only needs a value");
    out.push(...value.split(",").map((part) => part.trim()).filter(Boolean));
    index += 1;
  }
  return out;
}

/** `--flag value` with a numeric value; a missing or unusable value is an error. */
export function numericArg(argv: readonly string[], flag: string, fallback: number): number {
  const index = argv.indexOf(flag);
  if (index < 0) return fallback;
  const raw = argv[index + 1];
  const value = raw === undefined || raw.startsWith("--") ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) throw new WarmArgError(`${flag} needs a number`);
  return value;
}

/**
 * One report line per row. `status` and `reason` are plain strings because `--check`
 * reports stored rows with its own vocabulary (`ok`, `warn:stale`, `fail:missing`).
 * Never carries a URL, a host or any value from the env.
 */
export function warmRowLine(
  row: Pick<
    WarmRow,
    "presetId" | "locale" | "narration" | "modelUsed" | "geminiCalls" | "qlooCalls" | "attempts"
  > & { status: string; reason: string; extra?: string },
): string {
  const parts = [
    row.presetId,
    row.locale,
    row.status,
    `reason=${row.reason}`,
    `attempts=${row.attempts}`,
    `A=${row.narration.A}`,
    `B=${row.narration.B}`,
    `modelA=${row.modelUsed.A ?? "none"}`,
    `modelB=${row.modelUsed.B ?? "none"}`,
    `gemini=${row.geminiCalls}`,
    `qloo=${row.qlooCalls}`,
  ];
  if (row.extra) parts.push(row.extra);
  return parts.join(" ");
}

type PlanShape = { coverage?: unknown };

/** The one reader of `coverage.llm`, for the CLI, the rounds and the tests. */
export function planLlmReport(pack: PlanShape | undefined): {
  narrative: "llm" | "template" | null;
  modelUsed: string | null;
  failures: string[];
} {
  const coverage = pack?.coverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    return { narrative: null, modelUsed: null, failures: [] };
  }
  const llm = (coverage as { llm?: unknown }).llm;
  if (!llm || typeof llm !== "object" || Array.isArray(llm)) {
    return { narrative: null, modelUsed: null, failures: [] };
  }
  const row = llm as { narrative?: unknown; modelUsed?: { narrative?: unknown }; failures?: unknown };
  return {
    narrative: row.narrative === "llm" ? "llm" : row.narrative === "template" ? "template" : null,
    modelUsed: typeof row.modelUsed?.narrative === "string" ? row.modelUsed.narrative : null,
    failures: Array.isArray(row.failures)
      ? row.failures.filter((code): code is string => typeof code === "string")
      : [],
  };
}

/** Reader for the fields a warm row reports, shared by the CLI and the tests. */
export function planReport(payload: PackCachePayload): {
  narration: { A: string; B: string };
  modelUsed: { A: string | null; B: string | null };
} {
  const a = planLlmReport(payload.packs.find((pack) => pack.label === "A"));
  const b = planLlmReport(payload.packs.find((pack) => pack.label === "B"));
  return {
    narration: { A: a.narrative ?? "missing", B: b.narrative ?? "missing" },
    modelUsed: { A: a.modelUsed, B: b.modelUsed },
  };
}

/**
 * Why a template row stayed a template row, from the failures the pipeline recorded.
 * The most specific quota reason wins, because it is the one an operator can act on.
 */
export function llmReasonFor(payload: PackCachePayload): WarmReason {
  const failures = payload.packs.flatMap((pack) => planLlmReport(pack).failures);
  if (failures.includes("quota_daily")) return "quota_daily";
  if (failures.includes("quota_minute")) return "quota_minute";
  if (failures.some((code) => code === "timeout" || code === "deadline")) return "timeout";
  return "llm_error";
}

/** Classify a thrown build error so the row says Qloo, the guard or the pipeline. */
export function classifyBuildError(error: unknown): Extract<WarmReason, "qloo_guard" | "qloo_error" | "build_error"> {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (name === "QlooQuotaError" || name === "QlooGuardError") return "qloo_guard";
  if (name.startsWith("Qloo") || /qloo/i.test(message)) return "qloo_error";
  return "build_error";
}

function rowFor(input: {
  target: WarmTarget;
  status: WarmStatus;
  reason: WarmReason;
  payload?: PackCachePayload;
  geminiCalls: number;
  qlooCalls: number;
  attempts: number;
  ms: number;
  extra?: string;
}): WarmRow {
  const report = input.payload
    ? planReport(input.payload)
    : { narration: { A: "missing", B: "missing" }, modelUsed: { A: null, B: null } };
  return {
    presetId: input.target.presetId,
    locale: input.target.locale,
    status: input.status,
    reason: input.reason,
    narration: report.narration,
    modelUsed: report.modelUsed,
    geminiCalls: input.geminiCalls,
    qlooCalls: input.qlooCalls,
    attempts: input.attempts,
    ms: input.ms,
  };
}

/**
 * Build one row, then keep it only if it is better than what is stored.
 *
 * The chain being exhausted is not a failure: the pipeline degrades to rule B and the
 * template on its own, so the row is written (or kept) and the reason names the quota.
 * Only a build error — Qloo guarded, Qloo failing, the pipeline throwing — ends a row
 * as `failed`.
 */
export async function warmOne(target: WarmTarget, deps: WarmDeps): Promise<WarmRow> {
  const started = deps.now();
  const geminiBefore = deps.geminiCalls();
  const qlooBefore = deps.qlooCalls();
  const spent = () => ({
    geminiCalls: Math.max(0, deps.geminiCalls() - geminiBefore),
    qlooCalls: Math.max(0, deps.qlooCalls() - qlooBefore),
  });

  const state = deps.llm();
  const llmOn = state.configured && !state.disabled;
  const attemptsMax = llmOn ? WARM_ATTEMPTS : 1;
  let best: Extract<WarmBuild, { ok: true }> | null = null;
  let attempts = 0;
  let reason: WarmReason = "build_error";

  for (let attempt = 1; attempt <= attemptsMax; attempt += 1) {
    attempts = attempt;
    const quota = deps.qlooQuota();
    if (quota.blocked || (quota.remaining !== undefined && quota.remaining < QLOO_CUSTOM_RESERVE)) {
      if (best) break;
      return rowFor({
        target,
        status: "failed",
        reason: "qloo_guard",
        ...spent(),
        attempts,
        ms: deps.now() - started,
      });
    }
    const built = await deps.build(target);
    if (!built.ok) {
      reason = built.reason;
      break;
    }
    best = pickBetter(best, built);
    if (packNarrationGrade(best.payload) === "llm") break;
    // Every model skipped: another build would degrade to the same template, so it
    // would only spend calls (and a row's worth of Qloo) to prove nothing.
    if (llmOn && deps.dailyExhaustion().exhausted) break;
    if (attempt < attemptsMax) await deps.sleep(WARM_RETRY_PAUSE_MS);
  }

  if (!best) {
    return rowFor({
      target,
      status: "failed",
      reason,
      ...spent(),
      attempts,
      ms: deps.now() - started,
    });
  }

  const grade = packNarrationGrade(best.payload);
  const result = await deps.write({
    target,
    payload: best.payload,
    qlooCalls: best.qlooCalls,
  });
  return rowFor({
    target,
    // `wrote: false` means the stored row is at least as good — an llm row that a
    // template build must never replace.
    status: grade === "llm" ? "cached" : result.wrote ? "template" : "kept",
    reason: grade === "llm" ? "ok" : llmReasonFor(best.payload),
    payload: best.payload,
    ...spent(),
    attempts,
    ms: deps.now() - started,
  });
}

/** The better of two builds: an llm payload wins, an equal grade takes the newer one. */
function pickBetter(
  left: Extract<WarmBuild, { ok: true }> | null,
  right: Extract<WarmBuild, { ok: true }>,
): Extract<WarmBuild, { ok: true }> {
  if (!left) return right;
  const leftGrade = packNarrationGrade(left.payload);
  const rightGrade = packNarrationGrade(right.payload);
  if (rightGrade === "llm" && leftGrade === "template") return right;
  if (rightGrade === leftGrade) return right;
  return left;
}

async function storedGrade(target: WarmTarget, deps: WarmDeps): Promise<NarrationGrade | null> {
  const stored = await deps.readStored(target);
  return stored?.grade ?? null;
}

/** Rows the matrix still has to rebuild: everything that is not already an llm row. */
export async function pendingTargets(targets: WarmTarget[], deps: WarmDeps): Promise<WarmTarget[]> {
  const out: WarmTarget[] = [];
  for (const target of targets) {
    if ((await storedGrade(target, deps)) === "llm") continue;
    out.push(target);
  }
  return out;
}

async function allLlm(targets: WarmTarget[], deps: WarmDeps): Promise<boolean> {
  return (await pendingTargets(targets, deps)).length === 0;
}

/**
 * Rounds of the matrix. A plain run is one round; `--until-ok` repeats only the rows
 * that are not already `llm`, never more than `maxRounds` times and never with a pause
 * shorter than `pauseMs`, and it stops as soon as the daily quota or the Qloo reserve
 * makes another round pointless.
 */
export async function runWarmRounds(
  targets: WarmTarget[],
  options: WarmRunOptions,
  deps: WarmDeps,
): Promise<WarmRunResult> {
  const roundsMax = options.untilOk ? Math.max(1, options.maxRounds) : 1;
  const rows: WarmRow[] = [];
  let rounds = 0;
  let stop: WarmStop = "single_round";
  let resetMs: number | null = null;

  for (let round = 1; round <= roundsMax; round += 1) {
    if (round > 1) await deps.sleep(Math.max(WARM_MIN_PAUSE_S * 1000, options.pauseMs));
    const pending = await pendingTargets(targets, deps);
    if (pending.length === 0) {
      stop = "all_llm";
      break;
    }
    rounds = round;
    for (const target of pending) {
      rows.push(await warmOne(target, deps));
    }
    if (await allLlm(targets, deps)) {
      stop = "all_llm";
      break;
    }
    if (!options.untilOk) {
      stop = "single_round";
      break;
    }
    const daily = deps.dailyExhaustion();
    if (daily.exhausted) {
      stop = "quota_daily";
      resetMs = daily.resetMs;
      break;
    }
    const quota = deps.qlooQuota();
    if (quota.blocked || (quota.remaining !== undefined && quota.remaining < QLOO_CUSTOM_RESERVE)) {
      stop = "qloo_reserve";
      break;
    }
    if (round === roundsMax) {
      stop = "max_rounds";
      break;
    }
  }

  return { rows, rounds, stop, resetMs };
}

/** Epoch ms as Guatemala time (UTC−6, no daylight saving), for the operator to read. */
export function guatemalaTime(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Guatemala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const at = (type: string) => parts.find((part) => part.type === type)?.value ?? "?";
  return `${at("year")}-${at("month")}-${at("day")} ${at("hour")}:${at("minute")} (UTC-6)`;
}

export type WarmSummary = {
  cached: number;
  kept: number;
  template: number;
  failed: number;
};

export function summarize(rows: readonly WarmRow[]): WarmSummary {
  const out: WarmSummary = { cached: 0, kept: 0, template: 0, failed: 0 };
  for (const row of rows) out[row.status] += 1;
  return out;
}

/** Counts per outcome, the spend, and the exact command the operator runs next. */
export function summaryLine(input: {
  rows: readonly WarmRow[];
  rounds: number;
  geminiCalls: number;
  qlooCalls: number;
  targets: number;
  llmRows: number;
}): string {
  const counts = summarize(input.rows);
  const next =
    input.llmRows === input.targets ? "pnpm warm:remote --check" : "pnpm warm:remote --until-ok";
  return [
    `warm summary rounds=${input.rounds}`,
    `rows=${input.rows.length}`,
    `cached=${counts.cached}`,
    `kept=${counts.kept}`,
    `template=${counts.template}`,
    `failed=${counts.failed}`,
    `llm_rows=${input.llmRows}/${input.targets}`,
    `gemini=${input.geminiCalls}`,
    `qloo=${input.qlooCalls}`,
    `next: ${next}`,
  ].join(" ");
}

/**
 * The message an early stop prints. `quota_daily` is the only one that names an
 * instant, and it is in Guatemala time because that is where the operator is.
 */
export function stopLine(stop: WarmStop, resetMs: number | null): string | null {
  if (stop === "quota_daily") {
    return `warm stopped: every gemini model is out of daily quota; it resets ${guatemalaTime(
      resetMs ?? Date.now(),
    )}`;
  }
  if (stop === "qloo_reserve") return "warm stopped: qloo remaining is below the custom reserve";
  if (stop === "max_rounds") return "warm stopped: --max-rounds reached and rows are still not llm";
  return null;
}

/**
 * Report the deployment environment variable by variable.
 *
 * Prints a status per **name** and never a value: `ok`, `missing (required)`,
 * `missing (optional, default X)` or `invalid (reason)`. Exit code is non-zero
 * when anything is required-and-absent or invalid, so it can gate a deploy.
 *
 * `.env` is loaded only outside production. A production process must be driven
 * entirely by the environment it was started with.
 */
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { llmModelState } from "../src/lib/llm/provider";

const PRODUCTION = process.env.NODE_ENV === "production";

if (!PRODUCTION && existsSync(".env")) loadEnvFile(".env");

type Status = "ok" | "missing-required" | "missing-optional" | "invalid";

type Row = { name: string; status: Status; detail?: string };

const rows: Row[] = [];

/** Required means required *in production*: a dev shell need not carry them. */
function required(value: string | undefined, name: string, defaultValue?: string): void {
  const raw = value?.trim();
  if (raw) {
    rows.push({ name, status: "ok" });
    return;
  }
  if (PRODUCTION) rows.push({ name, status: "missing-required" });
  else if (defaultValue) rows.push({ name, status: "missing-optional", detail: defaultValue });
  else rows.push({ name, status: "missing-optional" });
}

function optional(value: string | undefined, name: string, defaultValue?: string): void {
  const raw = value?.trim();
  rows.push(
    raw
      ? { name, status: "ok" }
      : defaultValue
        ? { name, status: "missing-optional", detail: defaultValue }
        : { name, status: "missing-optional" },
  );
}

/** A numeric knob must parse when it is present; empty means the default. */
function numeric(value: string | undefined, name: string, defaultValue: string): void {
  const raw = value?.trim();
  if (!raw) {
    rows.push({ name, status: "missing-optional", detail: defaultValue });
    return;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    rows.push({ name, status: "invalid", detail: "expected a number >= 0" });
    return;
  }
  rows.push({ name, status: "ok" });
}

function flag(value: string | undefined, name: string): void {
  const raw = value?.trim();
  if (!raw) {
    rows.push({ name, status: "missing-optional", detail: "off" });
    return;
  }
  if (!["0", "1", "true", "false"].includes(raw.toLowerCase())) {
    rows.push({ name, status: "invalid", detail: "expected true, false, 1 or 0" });
    return;
  }
  rows.push({ name, status: "ok" });
}

/** Host of a connection string, bracketed IPv6 unwrapped. Never printed. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

function checkDatabaseUrl(value: string | undefined): void {
  const raw = value?.trim();
  if (!raw) {
    rows.push({
      name: "DATABASE_URL",
      status: PRODUCTION ? "missing-required" : "missing-optional",
    });
    return;
  }
  const host = hostOf(raw);
  if (host === null) {
    rows.push({ name: "DATABASE_URL", status: "invalid", detail: "not a valid URL" });
    return;
  }
  if (PRODUCTION && (host === "localhost" || host === "127.0.0.1" || host === "::1")) {
    rows.push({ name: "DATABASE_URL", status: "invalid", detail: "local host" });
    return;
  }
  rows.push({ name: "DATABASE_URL", status: "ok" });
}

function checkSessionSecret(value: string | undefined): void {
  const raw = value?.trim();
  if (!raw) {
    rows.push({
      name: "SESSION_SECRET",
      status: PRODUCTION ? "missing-required" : "missing-optional",
    });
    return;
  }
  if (PRODUCTION && raw.length < 32) {
    // Length only: the secret itself is never echoed.
    rows.push({ name: "SESSION_SECRET", status: "invalid", detail: "shorter than 32 characters" });
    return;
  }
  rows.push({ name: "SESSION_SECRET", status: "ok" });
}

// --- database and session ---------------------------------------------------
checkDatabaseUrl(process.env.DATABASE_URL);
checkSessionSecret(process.env.SESSION_SECRET);

// --- Qloo -------------------------------------------------------------------
required(process.env.QLOO_API_KEY, "QLOO_API_KEY");
optional(process.env.QLOO_BASE_URL, "QLOO_BASE_URL", "https://hackathon.api.qloo.com");
numeric(process.env.QLOO_MONTHLY_LIMIT, "QLOO_MONTHLY_LIMIT", "10000");
numeric(process.env.QLOO_USED_BASELINE, "QLOO_USED_BASELINE", "0");
numeric(process.env.QLOO_CUSTOM_RESERVE, "QLOO_CUSTOM_RESERVE", "2000");

// --- abuse, quota and cache knobs -------------------------------------------
numeric(process.env.TRUSTED_PROXY_HOPS, "TRUSTED_PROXY_HOPS", "1");
numeric(process.env.LIVE_GENERATIONS_PER_DAY, "LIVE_GENERATIONS_PER_DAY", "250");
numeric(process.env.LLM_CALLS_PER_HOUR, "LLM_CALLS_PER_HOUR", "120");
numeric(process.env.PACK_CACHE_TTL_HOURS, "PACK_CACHE_TTL_HOURS", "24");
flag(process.env.LOG_IP_PROBE, "LOG_IP_PROBE");

// --- LLM --------------------------------------------------------------------
flag(process.env.LLM_DISABLED, "LLM_DISABLED");

const declaredProvider = process.env.LLM_PROVIDER?.trim().toLowerCase() ?? "";
if (!declaredProvider) {
  rows.push({
    name: "LLM_PROVIDER",
    status: "missing-optional",
    detail: "auto: nebius when its three variables are set",
  });
} else if (declaredProvider === "google" || declaredProvider === "nebius") {
  rows.push({ name: "LLM_PROVIDER", status: "ok" });
} else {
  rows.push({ name: "LLM_PROVIDER", status: "invalid", detail: "expected google or nebius" });
}

const state = llmModelState();
// The provider that is actually in play, whether declared or inferred.
const activeProvider = state.configured
  ? state.provider
  : declaredProvider === "google" || declaredProvider === "nebius"
    ? declaredProvider
    : "";

const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()
  ? process.env.GOOGLE_GENERATIVE_AI_API_KEY
  : process.env.GEMINI_API_KEY;

if (activeProvider === "google") {
  required(googleKey, "GOOGLE_GENERATIVE_AI_API_KEY");
} else {
  optional(process.env.GOOGLE_GENERATIVE_AI_API_KEY, "GOOGLE_GENERATIVE_AI_API_KEY");
}
optional(process.env.GEMINI_API_KEY, "GEMINI_API_KEY");
optional(process.env.GEMINI_MODEL, "GEMINI_MODEL", "falls back to LLM_MODEL; no built-in default");
optional(process.env.GEMINI_FALLBACK_MODELS, "GEMINI_FALLBACK_MODELS", "none");
optional(process.env.LLM_MODEL, "LLM_MODEL", "google only, when GEMINI_MODEL is empty");

for (const name of ["NEBIUS_API_KEY", "NEBIUS_BASE_URL", "NEBIUS_MODEL"]) {
  if (activeProvider === "nebius") required(process.env[name], name);
  else optional(process.env[name], name);
}

numeric(process.env.GEMINI_RETRY_ATTEMPTS, "GEMINI_RETRY_ATTEMPTS", "3");
numeric(process.env.GEMINI_RETRY_DELAY_MS, "GEMINI_RETRY_DELAY_MS", "1000");
numeric(process.env.GEMINI_RETRY_MAX_DELAY_MS, "GEMINI_RETRY_MAX_DELAY_MS", "8000");
numeric(process.env.DROPQ_LLM_BUDGET, "DROPQ_LLM_BUDGET", "uncapped");

// The chain has to name at least one model whenever the LLM is meant to run.
if (state.configured) {
  rows.push({ name: "MODEL_CHAIN", status: "ok", detail: `provider ${state.provider}` });
} else if (state.reason === "no_model") {
  rows.push({
    name: "MODEL_CHAIN",
    status: "invalid",
    detail: "no model: set GEMINI_MODEL or LLM_MODEL",
  });
} else if (state.reason === "disabled") {
  rows.push({ name: "MODEL_CHAIN", status: "ok", detail: "llm disabled" });
} else if (state.reason.startsWith("unknown_provider")) {
  // Already reported on the LLM_PROVIDER line.
} else {
  // Off for a missing key or an unset provider: template narration still works.
  rows.push({ name: "MODEL_CHAIN", status: "ok", detail: "llm off, template narration" });
}

function render(row: Row): string {
  if (row.status === "missing-required") return `${row.name}  missing (required)`;
  if (row.status === "missing-optional") {
    return row.detail
      ? `${row.name}  missing (optional, default ${row.detail})`
      : `${row.name}  missing (optional)`;
  }
  if (row.status === "invalid") return `${row.name}  invalid (${row.detail ?? "unknown"})`;
  return `${row.name}  ok${row.detail ? ` (${row.detail})` : ""}`;
}

console.log(`env:check (${PRODUCTION ? "production" : "non-production"})`);
for (const row of rows) console.log(render(row));

const failures = rows.filter((row) => row.status === "missing-required" || row.status === "invalid");
console.log(`${rows.length} checked, ${failures.length} problem(s)`);
process.exit(failures.length > 0 ? 1 : 0);

/**
 * Structured narration probe against every model in the Gemini chain, on the
 * saved Latin tour → Houston fixture. No Qloo call. Prints a summary table.
 *
 * `--samples <n>` (default 1) and `--gap <ms>` (default 0): round-robin across
 * models so a slow period does not hit only one model.
 */
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { readGeminiConfig } from "../src/lib/llm/gemini-chain";
import { probeNarrationModel, type NarrationProbe } from "../src/lib/pipeline/llm";

if (existsSync(".env")) loadEnvFile(".env");

function argValue(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1]!;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ModelSummary = {
  model: string;
  successes: number;
  samples: number;
  medianMs: number;
  maxMs: number;
  outcomes: string[];
  any429: boolean;
  rateLimitKinds: string[];
  allValid: boolean;
};

function summarize(model: string, rows: NarrationProbe[]): ModelSummary {
  const latencies = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
  const successes = rows.filter((row) => row.outcome === "200" && row.valid).length;
  const outcomes = [...new Set(rows.map((row) => row.outcome))];
  const kinds = [
    ...new Set(rows.flatMap((row) => (row.rateLimitKind ? [row.rateLimitKind] : []))),
  ];
  return {
    model,
    successes,
    samples: rows.length,
    medianMs: median(latencies),
    maxMs: latencies[latencies.length - 1] ?? 0,
    outcomes,
    any429: rows.some((row) => row.outcome === "429"),
    rateLimitKinds: kinds,
    allValid: successes === rows.length,
  };
}

function printSummary(summaries: ModelSummary[]): void {
  console.log("| model | ok/n | median ms | max ms | outcomes | valid | 429 |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of summaries) {
    const kind =
      row.any429 ? (row.rateLimitKinds.length > 0 ? row.rateLimitKinds.join(",") : "unknown") : "none";
    console.log(
      `| ${row.model} | ${row.successes}/${row.samples} | ${row.medianMs} | ${row.maxMs} | ${row.outcomes.join(",")} | ${row.allValid ? "yes" : "no"} | ${kind} |`,
    );
  }
}

/**
 * Decision rule: among models with n/n valid answers, order by median ascending.
 * Medians within 15% keep current relative order. Any failure goes last.
 */
function decideOrder(models: string[], summaries: ModelSummary[]): string[] {
  const byModel = new Map(summaries.map((row) => [row.model, row]));
  const perfect = models.filter((id) => {
    const row = byModel.get(id);
    return row && row.successes === row.samples;
  });
  const failed = models.filter((id) => !perfect.includes(id));
  const ranked = [...perfect].sort((left, right) => {
    const a = byModel.get(left)!;
    const b = byModel.get(right)!;
    const closer = Math.min(a.medianMs, b.medianMs);
    if (closer > 0 && Math.abs(a.medianMs - b.medianMs) / closer <= 0.15) {
      return models.indexOf(left) - models.indexOf(right);
    }
    return a.medianMs - b.medianMs;
  });
  return [...ranked, ...failed];
}

async function main(): Promise<void> {
  const samples = Math.max(1, Number(argValue("--samples", "1")) || 1);
  const gapMs = Math.max(0, Number(argValue("--gap", "0")) || 0);
  const read = readGeminiConfig();
  if (!read.ok) {
    console.log(`LLM off (${read.off})`);
    process.exit(1);
  }
  const models = read.config.models;
  console.log(`chain (${models.length}): ${models.join(" -> ")}`);
  console.log(`thinking=minimal samples=${samples} gapMs=${gapMs}`);

  const byModel = new Map<string, NarrationProbe[]>(models.map((id) => [id, []]));
  const total = models.length * samples;
  let done = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    for (const modelId of models) {
      if (done > 0 && gapMs > 0) await sleep(gapMs);
      const row = await probeNarrationModel(modelId, true);
      byModel.get(modelId)!.push(row);
      done += 1;
      console.log(
        `[${done}/${total}] ${modelId} outcome=${row.outcome} ${row.latencyMs}ms valid=${row.valid}${row.rateLimitKind ? ` 429=${row.rateLimitKind}` : ""}`,
      );
    }
  }

  const summaries = models.map((id) => summarize(id, byModel.get(id)!));
  console.log("");
  printSummary(summaries);
  const order = decideOrder(models, summaries);
  console.log(`recommended order: ${order.join(" -> ")}`);
  if (order[0] !== models[0]) {
    console.log(`fastest with thinking=minimal: ${order[0]}. Set GEMINI_MODEL to that id.`);
  } else {
    console.log(`fastest with thinking=minimal: ${order[0]} (already the principal).`);
  }
}

void main();

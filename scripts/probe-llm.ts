/**
 * One structured narration call per model in the Gemini chain, on the saved
 * Latin tour → Houston fixture. No Qloo call. Prints a table and nothing else.
 */
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { readGeminiConfig } from "../src/lib/llm/gemini-chain";
import { probeNarrationModel, type NarrationProbe } from "../src/lib/pipeline/llm";

if (existsSync(".env")) loadEnvFile(".env");

function printTable(rows: NarrationProbe[]): void {
  console.log("| model | outcome | latency ms | reasoning tokens | valid |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const row of rows) {
    console.log(
      `| ${row.model} | ${row.outcome} | ${row.latencyMs} | ${row.reasoningTokens ?? "none"} | ${row.valid ? "yes" : "no"} |`,
    );
  }
}

async function main(): Promise<void> {
  const read = readGeminiConfig();
  if (!read.ok) {
    console.log(`LLM off (${read.off})`);
    process.exit(1);
  }
  console.log(`chain (${read.config.models.length}): ${read.config.models.join(" -> ")}`);
  const on: NarrationProbe[] = [];
  console.log("\nthinking=minimal");
  for (const modelId of read.config.models) on.push(await probeNarrationModel(modelId, true));
  printTable(on);
  const off: NarrationProbe[] = [];
  console.log("\nthinking=off");
  for (const modelId of read.config.models) off.push(await probeNarrationModel(modelId, false));
  printTable(off);
  const fastest = [...on].sort((left, right) => left.latencyMs - right.latencyMs)[0];
  if (fastest && fastest.model !== read.config.models[0]) {
    console.log(`fastest with thinking=minimal: ${fastest.model}. Set GEMINI_MODEL to that id.`);
  } else if (fastest) {
    console.log(`fastest with thinking=minimal: ${fastest.model} (already the principal).`);
  }
}

void main();

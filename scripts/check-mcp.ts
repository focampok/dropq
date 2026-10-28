/**
 * Smoke-test the MCP endpoint with the official SDK client.
 *
 *   pnpm mcp:check                                   # production preset path
 *   MCP_URL=http://localhost:3311/api/mcp pnpm mcp:check
 *   pnpm mcp:check -- --deep-cuts                    # also builds the deep Bridge
 *
 * The default anchors match the Roots GT → LA preset, so a deployment with a warm
 * cache answers without spending Qloo or Gemini.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL?.trim() || "https://dropq.focampo.com/api/mcp";
const forwarded = process.env.MCP_FORWARDED_FOR?.trim() || "198.51.100.77";
const deepCuts = process.argv.includes("--deep-cuts");

function textOf(result: unknown): string {
  const content = Array.isArray((result as { content?: unknown })?.content)
    ? ((result as { content: unknown[] }).content)
    : [];
  const block = content.find(
    (entry) => entry && typeof entry === "object" && (entry as { type?: unknown }).type === "text",
  ) as { text?: unknown } | undefined;
  return typeof block?.text === "string" ? block.text : JSON.stringify(result);
}

async function main(): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { "x-forwarded-for": forwarded } },
  });
  const client = new Client({ name: "dropq-mcp-check", version: "1.0.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    console.log(`endpoint: ${url}`);
    console.log(`tools: ${tools.map((tool) => tool.name).join(", ")}`);

    const presets = await client.callTool({ name: "list_presets", arguments: {} });
    const presetBody = JSON.parse(textOf(presets)) as {
      presets?: { id: string; locales?: Record<string, unknown> }[];
    };
    console.log(
      `cached presets: ${(presetBody.presets ?? [])
        .map((preset) => `${preset.id}(${Object.keys(preset.locales ?? {}).join("/")})`)
        .join(", ") || "none"}`,
    );

    const packed = await client.callTool({
      name: "pack_night",
      arguments: {
        anchors: ["Ricardo Arjona", "Pollo Campero", "Gaby Moreno"],
        city: "Los Angeles",
        event_kind: "comunidad",
        ...(deepCuts ? { deep_cuts: true } : {}),
      },
    });
    console.log("pack_night:");
    console.log(textOf(packed));
  } finally {
    await client.close().catch(() => undefined);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

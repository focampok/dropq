/**
 * M1–M4: the MCP endpoint, driven by the official SDK client over Streamable HTTP.
 *
 * The pack_night call uses a warmed preset and must be a cache hit. In the prod
 * profile a miss is fatal for the same reason a preset click is: the deployment would
 * have spent Qloo to answer the check.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Acc, type Ctx } from "../lib/ctx";
import { PresetCacheMissError, nextForwarded } from "../lib/harness";
import { PUBLIC_BASE_URL } from "../../src/lib/mcp/config";

const PRESET_ANCHORS = ["Ricardo Arjona", "Pollo Campero", "Gaby Moreno"];

function textOf(result: unknown): string {
  const content = Array.isArray((result as { content?: unknown })?.content)
    ? ((result as { content: unknown[] }).content)
    : [];
  const block = content.find(
    (entry) => entry && typeof entry === "object" && (entry as { type?: unknown }).type === "text",
  ) as { text?: unknown } | undefined;
  if (!block || typeof block.text !== "string") throw new Error("tool result has no text block");
  return block.text;
}

function jsonOf(result: unknown): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

async function connect(ctx: Ctx): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${ctx.base}/api/mcp`), {
    requestInit: { headers: { "x-forwarded-for": nextForwarded() } },
  });
  const client = new Client({ name: "dropq-e2e", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

export async function runMcpChecks(ctx: Ctx): Promise<void> {
  const m1 = new Acc("M1", "MCP initializes and lists the DropQ tools", "free");
  const m2 = new Acc("M2", "Tool schemas expose anchors/city/event_kind/lang/deep_cuts", "free");
  const m3 = new Acc("M3", "list_presets returns warmed cached presets", "free");
  const m4 = new Acc("M4", "pack_night with a preset is a zero-spend cache hit", "free");

  let client: Client | null = null;
  try {
    client = await connect(ctx);
    m1.pass();

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of ["pack_night", "list_presets"]) {
      if (!names.includes(name)) m2.fail(`tools/list is missing ${name}`);
    }
    const pack = tools.find((tool) => tool.name === "pack_night");
    const properties =
      pack && typeof pack.inputSchema === "object" && pack.inputSchema !== null
        ? ((pack.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})
        : {};
    for (const field of ["anchors", "city", "event_kind", "lang", "deep_cuts"]) {
      if (!(field in properties)) m2.fail(`pack_night schema is missing ${field}`);
    }
    const required = new Set(
      pack && typeof pack.inputSchema === "object" && pack.inputSchema !== null
        ? ((pack.inputSchema as { required?: unknown[] }).required ?? [])
        : [],
    );
    for (const field of ["anchors", "city", "event_kind"]) {
      if (!required.has(field)) m2.fail(`pack_night does not require ${field}`);
    }
    m2.pass();

    const presets = jsonOf(await client.callTool({ name: "list_presets", arguments: {} }));
    const rows = Array.isArray(presets.presets) ? presets.presets : [];
    if (rows.length === 0) m3.fail("list_presets returned no cached preset");
    const roots = rows.find(
      (row) => row && typeof row === "object" && (row as { id?: unknown }).id === "roots-gt-la",
    ) as { locales?: Record<string, unknown> } | undefined;
    if (!roots) {
      m3.fail("roots-gt-la is not in the cached preset list");
    } else {
      for (const locale of ["en", "es"] as const) {
        if (!roots.locales?.[locale]) m3.fail(`roots-gt-la has no cached ${locale} row`);
      }
    }
    m3.pass();

    const before = ctx.profile === "local" ? await ctx.qlooBuiltSince(ctx.runStart) : 0;
    const packed = jsonOf(
      await client.callTool({
        name: "pack_night",
        arguments: {
          anchors: PRESET_ANCHORS,
          city: "Los Angeles",
          event_kind: "comunidad",
        },
      }),
    );
    const cache = packed.cache as { pack?: unknown } | undefined;
    if (cache?.pack !== "hit") {
      const message = "the preset pack response was not served from the stored cache";
      m4.fail(message);
      if (ctx.profile === "prod") throw new PresetCacheMissError(`dropq/api/mcp: ${message}`);
    }
    const plans = Array.isArray(packed.plans) ? packed.plans : [];
    if (plans.length !== 2) m4.fail(`pack_night returned ${plans.length} plans, expected 2`);
    for (const plan of plans) {
      const items = (plan as { items?: unknown }).items;
      if (!Array.isArray(items) || items.length !== 4) {
        m4.fail(`a plan has ${Array.isArray(items) ? items.length : "no"} cards, expected 4`);
        continue;
      }
      for (const item of items) {
        const row = item as { entityId?: unknown; evidence?: unknown };
        if (typeof row.entityId !== "string" || !row.entityId.trim()) {
          m4.fail(`a ${String((item as { slot?: unknown }).slot)} card has no entity id`);
        }
        if (!row.evidence || typeof row.evidence !== "object") {
          m4.fail(`a ${String((item as { slot?: unknown }).slot)} card has no evidence`);
        }
      }
    }
    const briefUrl = typeof packed.briefUrl === "string" ? packed.briefUrl : "";
    if (!briefUrl.startsWith(`${PUBLIC_BASE_URL}/packs/`) || !briefUrl.endsWith("/brief")) {
      m4.fail(`briefUrl is not a public DropQ brief: ${briefUrl || "(missing)"}`);
    }
    if (packed.briefAccess !== "public") {
      m4.fail(`briefAccess is ${String(packed.briefAccess)}, expected public for a preset`);
    }
    if (ctx.profile === "local") {
      const after = await ctx.qlooBuiltSince(ctx.runStart);
      if (after !== before) m4.fail(`pack_night spent ${after - before} Qloo build call(s)`);
    }
    m4.pass();
  } catch (error) {
    if (error instanceof PresetCacheMissError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    for (const acc of [m1, m2, m3, m4]) acc.fail(message);
  } finally {
    await client?.close().catch(() => undefined);
    for (const acc of [m1, m2, m3, m4]) acc.finish(ctx.recorder, 0);
  }
}

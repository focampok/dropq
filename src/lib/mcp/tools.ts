/**
 * DropQ's MCP surface.
 *
 * The tools deliberately delegate to the same session + pack routes the browser uses:
 * `pack_night` creates a session and calls the pack route, then the refine route when
 * Deep cuts is asked for. That keeps one pipeline, one cache, and one set of rate/quota
 * guards. Nothing here re-implements the run.
 *
 * This module stays free of Prisma and Next response objects so the tool shapes can be
 * unit-tested with the in-memory MCP transport; `live.ts` supplies the real deps.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CachedPack, PackCachePayload } from "@/lib/pack/cache";
import { CITY_VALUES, EVENT_KINDS, matchesPresetSeeds } from "@/lib/presets";
import { sanitizeSeedText } from "@/lib/session/schema";

export type Lang = "en" | "es";
export type McpCity = (typeof CITY_VALUES)[number];
export type McpEventKind = (typeof EVENT_KINDS)[number];
export type DeepCutsMode = "not_requested" | "snapshot" | "live";

const SLOTS = ["watch", "listen", "wear", "do"] as const;

export type TraceEvent = {
  step?: string;
  status?: string;
  detail?: string;
  cached?: boolean;
  geminiCalls?: number;
  packIds?: string[];
};

export type RouteOutcome =
  | { ok: true; cached: boolean; events: TraceEvent[] }
  | { ok: false; status: number; error: string; message?: string };

export type LoadedPack = {
  payload: PackCachePayload;
  packIds: { A: string | null; B: string | null };
};

export type PresetSummary = {
  id: string;
  city: string;
  eventKind: string;
  anchors: { rawText: string; resolvedName: string | null; entityId: string | null }[];
  locales: Partial<Record<Lang, { builtAt: string; plans: PlanResult[] }>>;
};

export type PlanItemResult = {
  slot: (typeof SLOTS)[number];
  entityId: string;
  name: string;
  type: string;
  hop: number;
  confidence: string;
  explain: string | null;
  evidence?: unknown;
};

export type PlanResult = {
  label: "A" | "B";
  axis: "root" | "bridge";
  narrative: string;
  headline: string;
  narrationSource: "llm" | "template";
  coverage: {
    notes: { en: string; es: string };
    anchors: "llm" | "fallback" | null;
    narrative: "llm" | "template";
    offReason: string | null;
    bridgeMode: string | null;
    ruleB: unknown;
  };
  items: PlanItemResult[];
};

export type PackNightResult = {
  sessionId: string;
  city: string;
  eventKind: string;
  lang: Lang;
  deepCuts: { requested: boolean; bridge: DeepCutsMode };
  cache: { pack: "hit" | "miss" };
  anchors: { rawText: string; resolvedName: string | null; entityId: string | null }[];
  plans: PlanResult[];
  briefUrl: string | null;
  briefAccess: "public" | "session";
  briefNote: string;
};

export type McpServerDeps = {
  request: Request;
  publicBaseUrl: string;
  createSession(input: {
    anchors: string[];
    city: McpCity;
    eventKind: McpEventKind;
    locale: Lang;
  }): Promise<string>;
  buildPack(sessionId: string, locale: Lang, request: Request): Promise<RouteOutcome>;
  refineDeepCuts(sessionId: string, request: Request): Promise<RouteOutcome>;
  loadPack(sessionId: string): Promise<LoadedPack | null>;
  listPresets(): Promise<PresetSummary[]>;
  deleteSession?(sessionId: string): Promise<void>;
  enforceRateLimit?(request: Request, scope: "other" | "pack_cheap"): { status: number; code: string } | null;
};

const anchorText = z
  .string()
  .transform(sanitizeSeedText)
  .pipe(z.string().min(1).max(80));

export const packNightInputSchema = z.object({
  anchors: z
    .array(anchorText)
    .min(3)
    .max(5)
    .refine((values) => new Set(values.map((value) => value.toLowerCase())).size === values.length, {
      message: "anchors must be distinct",
    }),
  city: z.enum(CITY_VALUES),
  event_kind: z.enum(EVENT_KINDS),
  lang: z.enum(["en", "es"]).optional(),
  deep_cuts: z.boolean().optional(),
});

export type PackNightInput = z.infer<typeof packNightInputSchema>;

function textResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function toolFailure(code: string, message: string, status?: number): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { error: { code, ...(status ? { status } : {}), message } },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

type Coverage = PlanResult["coverage"] & { headline: string };

function readCoverage(value: unknown): Coverage {
  const base =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const llm =
    base.llm && typeof base.llm === "object" && !Array.isArray(base.llm)
      ? (base.llm as Record<string, unknown>)
      : {};
  const notes =
    base.notes && typeof base.notes === "object" && !Array.isArray(base.notes)
      ? (base.notes as Record<string, unknown>)
      : {};
  const anchors =
    llm.anchors === "llm" || llm.anchors === "fallback" ? llm.anchors : null;
  return {
    notes: {
      en: typeof notes.en === "string" ? notes.en : "",
      es: typeof notes.es === "string" ? notes.es : "",
    },
    anchors,
    narrative: llm.narrative === "llm" ? "llm" : "template",
    headline: typeof llm.headline === "string" ? llm.headline : "",
    offReason: typeof llm.offReason === "string" ? llm.offReason : null,
    bridgeMode: typeof base.bridgeMode === "string" ? base.bridgeMode : null,
    ruleB: base.ruleB ?? null,
  };
}

/**
 * One stored plan, in the order the brief prints it. `includeEvidence` is true for
 * `pack_night` (the caller asked for the stored evidence) and false for the compact
 * `list_presets` view, whose job is discovery rather than the full record.
 */
export function toPlanResult(pack: CachedPack, includeEvidence = true): PlanResult {
  const { headline, ...coverage } = readCoverage(pack.coverage);
  return {
    label: pack.label,
    axis: pack.axis,
    narrative: pack.narrative ?? "",
    headline,
    narrationSource: coverage.narrative,
    coverage,
    items: SLOTS.flatMap((slot) => {
      const item = pack.items.find((entry) => entry.slot === slot);
      if (!item) return [];
      return [
        {
          slot,
          entityId: item.qlooEntityId,
          name: item.qlooName,
          type: item.qlooType,
          hop: item.hop,
          confidence: item.confidence,
          explain: item.explain,
          ...(includeEvidence ? { evidence: item.evidence } : {}),
        },
      ];
    }),
  };
}

/** Cache-only view used by `list_presets`; no session, no Qloo, no Gemini. */
export function summarizeCachedPack(
  payload: PackCachePayload,
  builtAt: Date,
): { builtAt: string; plans: PlanResult[] } {
  return {
    builtAt: builtAt.toISOString(),
    plans: payload.packs.map((pack) => toPlanResult(pack, false)),
  };
}

function anchorsForResult(
  requested: readonly string[],
  payload: PackCachePayload,
): PackNightResult["anchors"] {
  const byRaw = new Map(
    payload.seeds.map((seed) => [seed.rawText.trim().toLowerCase(), seed]),
  );
  return requested.map((rawText, index) => {
    const seed = byRaw.get(rawText.trim().toLowerCase()) ?? payload.seeds[index];
    return {
      rawText,
      resolvedName: seed?.resolvedName ?? null,
      entityId: seed?.resolvedEntityId ?? null,
    };
  });
}

export function toPackNightResult(input: {
  input: PackNightInput;
  sessionId: string;
  loaded: LoadedPack;
  cached: boolean;
  deepCuts: DeepCutsMode;
  publicBaseUrl: string;
}): PackNightResult {
  const { payload, packIds } = input.loaded;
  const briefPackId = packIds.B ?? packIds.A;
  const briefUrl = briefPackId
    ? `${input.publicBaseUrl.replace(/\/+$/, "")}/packs/${briefPackId}/brief`
    : null;
  const presetPack = matchesPresetSeeds(payload.seeds.map((seed) => seed.rawText));
  return {
    sessionId: input.sessionId,
    city: payload.city,
    eventKind: payload.eventKind,
    lang: payload.locale === "es" ? "es" : "en",
    deepCuts: { requested: input.input.deep_cuts === true, bridge: input.deepCuts },
    cache: { pack: input.cached ? "hit" : "miss" },
    anchors: anchorsForResult(input.input.anchors, payload),
    plans: payload.packs.map((pack) => toPlanResult(pack)),
    briefUrl,
    briefAccess: presetPack ? "public" : "session",
    briefNote: presetPack
      ? "This brief is public because the anchors match a warmed preset."
      : "This brief belongs to the browser session that built the pack and opens with that session's cookie.",
  };
}

function isSnapshotRestore(events: readonly TraceEvent[]): boolean {
  return events.some(
    (event) =>
      event.step === "insights_hop1" &&
      event.status === "skipped" &&
      event.detail === "snapshot",
  );
}

function routeFailure(outcome: Extract<RouteOutcome, { ok: false }>): CallToolResult {
  const messages: Record<string, string> = {
    rate_limited: "Too many requests. Try again shortly.",
    QUOTA_LOW: "Live data is temporarily limited; try a cached preset.",
    DEMO_RESTING: "The live demo is resting; try a cached preset.",
    not_found: "The session or pack could not be found.",
    forbidden: "The pack session could not be opened.",
  };
  return toolFailure(
    outcome.error,
    outcome.message ?? messages[outcome.error] ?? "The pack could not be built.",
    outcome.status,
  );
}

export async function packNightTool(
  deps: McpServerDeps,
  input: PackNightInput,
): Promise<CallToolResult> {
  const limited = deps.enforceRateLimit?.(deps.request, "other") ?? null;
  if (limited) return toolFailure(limited.code, "Too many requests. Try again shortly.", limited.status);

  // The SDK validates before the callback; this also protects direct callers and tests.
  const parsed = packNightInputSchema.safeParse(input);
  if (!parsed.success) {
    return toolFailure(
      "invalid_input",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "),
      400,
    );
  }
  const data = parsed.data;
  const locale: Lang = data.lang ?? "en";
  let sessionId: string;
  try {
    sessionId = await deps.createSession({
      anchors: data.anchors,
      city: data.city,
      eventKind: data.event_kind,
      locale,
    });
  } catch {
    return toolFailure("session_failed", "The pack session could not be created.", 500);
  }

  let keep = false;
  try {
    const built = await deps.buildPack(sessionId, locale, deps.request);
    if (!built.ok) return routeFailure(built);

    let deepMode: DeepCutsMode = "not_requested";
    if (data.deep_cuts === true) {
      const refined = await deps.refineDeepCuts(sessionId, deps.request);
      if (!refined.ok) return routeFailure(refined);
      deepMode = isSnapshotRestore(refined.events) ? "snapshot" : "live";
    }

    const loaded = await deps.loadPack(sessionId);
    if (!loaded || loaded.payload.packs.length === 0) {
      return toolFailure("pack_empty", "The pack was built but could not be read.", 500);
    }
    keep = true;
    return textResult(
      toPackNightResult({
        input: data,
        sessionId,
        loaded,
        cached: built.cached,
        deepCuts: deepMode,
        publicBaseUrl: deps.publicBaseUrl,
      }),
    );
  } catch {
    return toolFailure("pack_failed", "The pack could not be built.", 500);
  } finally {
    if (!keep && deps.deleteSession) {
      try {
        await deps.deleteSession(sessionId);
      } catch {
        /* cleanup is best effort */
      }
    }
  }
}

export async function listPresetsTool(deps: McpServerDeps): Promise<CallToolResult> {
  const limited = deps.enforceRateLimit?.(deps.request, "pack_cheap") ?? null;
  if (limited) return toolFailure(limited.code, "Too many requests. Try again shortly.", limited.status);
  try {
    const presets = await deps.listPresets();
    return textResult({
      presets,
      note: "Only presets already present in the pack cache are listed. Reading this list spends no Qloo or Gemini quota.",
    });
  } catch {
    return toolFailure("presets_failed", "The cached presets could not be read.", 500);
  }
}

const PACK_NIGHT_DESCRIPTION =
  "Build a DropQ night from 3-5 public cultural anchors, a destination city and an event kind (tour, con or comunidad). " +
  "Runs the same pipeline as the web app: Qloo resolves the anchors and fills both plans, and the optional model chooses " +
  "Bridge anchors and writes token-based narration. Returns Plan A (Roots) and Plan B (Bridge) with every Qloo entity id, " +
  "the stored evidence, and the printable brief URL. Anchors that match a warmed preset are served from the pack cache " +
  "and spend no Qloo or Gemini quota. A custom build uses the same rate limits, monthly reserve and daily cap as the UI.";

const LIST_PRESETS_DESCRIPTION =
  "List the warmed DropQ demo presets that are present in the pack cache, with the cached plans for each language. " +
  "Read-only: spends no Qloo or Gemini quota. Use a listed preset's anchors with pack_night for a cache-hit pack.";

export function createDropQMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer(
    { name: "dropq", version: "0.1.0" },
    {
      instructions:
        "DropQ turns 3-5 public cultural anchors and a destination city into two print-ready plans. " +
        "Call list_presets to see warmed examples, or pack_night to build. Every card is a Qloo entity and carries its entity id.",
    },
  );

  server.registerTool(
    "pack_night",
    {
      title: "Pack a night",
      description: PACK_NIGHT_DESCRIPTION,
      inputSchema: packNightInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => packNightTool(deps, input as PackNightInput),
  );

  server.registerTool(
    "list_presets",
    {
      title: "List cached presets",
      description: LIST_PRESETS_DESCRIPTION,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => listPresetsTool(deps),
  );

  return server;
}

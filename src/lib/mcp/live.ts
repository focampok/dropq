/**
 * Real dependencies for the MCP tools.
 *
 * The build and refine calls go through the app's own route handlers rather than a
 * second implementation. That is deliberate: `pack_night` therefore creates a session
 * the same way the UI does, reads/writes the same PackCache, and hits the same per-IP
 * limits, monthly reserve and daily cap. A preset anchor set is a cache hit; a custom
 * build is refused on exactly the same conditions as a custom build in the browser.
 */
import { POST as packRoute } from "@/app/api/session/[id]/pack/route";
import { POST as refineRoute } from "@/app/api/session/[id]/pack/refine/route";
import { prisma } from "@/lib/db";
import { PUBLIC_BASE_URL } from "@/lib/mcp/config";
import {
  packSignature,
  readPackCache,
  snapshotSessionPacks,
} from "@/lib/pack/cache";
import { PINNED_PRESETS } from "@/lib/pipeline/config";
import { enforceRateLimit } from "@/lib/rate-limit";
import { sealSessionId, sessionCookie } from "@/lib/session/cookie";
import {
  summarizeCachedPack,
  type Lang,
  type LoadedPack,
  type McpCity,
  type McpEventKind,
  type McpServerDeps,
  type PresetSummary,
  type RouteOutcome,
  type TraceEvent,
} from "@/lib/mcp/tools";

type RouteHandler = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

function internalHeaders(request: Request, cookie: string): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    cookie: `${sessionCookie.name}=${encodeURIComponent(cookie)}`,
  });
  // Forward the caller's address so the pack route's rate limiter sees the same
  // visitor the MCP request came from, not the app talking to itself.
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) headers.set("x-forwarded-for", forwarded);
  const realIp = request.headers.get("x-real-ip");
  if (realIp) headers.set("x-real-ip", realIp);
  return headers;
}

function parseEvents(text: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      /* a partial line is not a progress event */
    }
  }
  return events;
}

async function callRoute(
  handler: RouteHandler,
  request: Request,
  sessionId: string,
  suffix: string,
  body: unknown,
): Promise<RouteOutcome> {
  const cookie = await sealSessionId(sessionId);
  const url = new URL(`/api/session/${sessionId}${suffix}`, new URL(request.url).origin);
  const response = await handler(
    new Request(url, {
      method: "POST",
      headers: internalHeaders(request, cookie),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: sessionId }) },
  );

  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const error = typeof parsed?.error === "string" ? parsed.error : "failed";
    const message = typeof parsed?.en === "string" ? parsed.en : undefined;
    return { ok: false, status: response.status, error, ...(message ? { message } : {}) };
  }

  const events = parseEvents(await response.text());
  const failure = events.find((event) => event.step === "error");
  if (failure) {
    const error = failure.detail ?? "failed";
    return { ok: false, status: error === "QUOTA_LOW" ? 503 : 500, error };
  }
  return {
    ok: true,
    cached: response.headers.get("x-dropq-cache") === "hit",
    events,
  };
}

async function createSession(input: {
  anchors: string[];
  city: McpCity;
  eventKind: McpEventKind;
  locale: Lang;
}): Promise<string> {
  const session = await prisma.session.create({
    data: {
      city: input.city,
      eventKind: input.eventKind,
      locale: input.locale,
      lastActiveAt: new Date(),
    },
  });
  // Explicit ids keep the anchors in caller order: the pipeline and pinned-preset
  // detection read seeds ordered by id. `createMany` alone would not promise that.
  await prisma.seed.createMany({
    data: input.anchors.map((rawText, index) => ({
      id: `mcp_${session.id}_${index}`,
      sessionId: session.id,
      rawText,
      source: "text" as const,
    })),
  });
  return session.id;
}

async function loadPack(sessionId: string): Promise<LoadedPack | null> {
  const payload = await snapshotSessionPacks(sessionId);
  if (!payload) return null;
  const rows = await prisma.pack.findMany({
    where: { sessionId },
    select: { id: true, label: true },
  });
  return {
    payload,
    packIds: {
      A: rows.find((row) => row.label === "A")?.id ?? null,
      B: rows.find((row) => row.label === "B")?.id ?? null,
    },
  };
}

async function listPresets(): Promise<PresetSummary[]> {
  const presets: PresetSummary[] = [];
  for (const preset of PINNED_PRESETS) {
    const entityIds = preset.seeds.flatMap((seed) => (seed.entityId ? [seed.entityId] : []));
    if (entityIds.length !== preset.seeds.length) continue;
    const locales: PresetSummary["locales"] = {};
    for (const locale of ["en", "es"] as const) {
      const hit = await readPackCache(
        packSignature({
          entityIds,
          city: preset.city,
          eventKind: preset.eventKind,
          locale,
          mode: "default",
        }),
      );
      if (hit) locales[locale] = summarizeCachedPack(hit.payload, hit.builtAt);
    }
    if (Object.keys(locales).length === 0) continue;
    presets.push({
      id: preset.id,
      city: preset.city,
      eventKind: preset.eventKind,
      anchors: preset.seeds.map((seed) => ({
        rawText: seed.rawText,
        resolvedName: seed.resolvedName,
        entityId: seed.entityId,
      })),
      locales,
    });
  }
  return presets;
}

export function liveDeps(request: Request): McpServerDeps {
  return {
    request,
    publicBaseUrl: PUBLIC_BASE_URL,
    enforceRateLimit(req, scope) {
      const limited = enforceRateLimit(req, scope);
      return limited ? { status: limited.status, code: "rate_limited" } : null;
    },
    createSession,
    buildPack: (sessionId, locale, req) =>
      callRoute(packRoute, req, sessionId, "/pack", { lang: locale }),
    refineDeepCuts: (sessionId, req) =>
      callRoute(refineRoute, req, sessionId, "/pack/refine", { mode: "deep_cuts" }),
    loadPack,
    listPresets,
    async deleteSession(sessionId) {
      await prisma.session.delete({ where: { id: sessionId } });
    },
  };
}

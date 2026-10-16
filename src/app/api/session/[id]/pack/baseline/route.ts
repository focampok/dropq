import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, readJsonBody, safeServerError } from "@/lib/http";
import { isPresetSession } from "@/lib/abuse";
import { buildBaseline } from "@/lib/baseline/build";
import {
  beginBaselineFlight,
  readBaselineCache,
  writeBaselineIfBetter,
} from "@/lib/baseline/cache";
import { baselineSignature } from "@/lib/baseline/signature";
import { packEntityIdsBySlot } from "@/lib/baseline/validate";
import { PINNED_PRESETS } from "@/lib/pipeline/config";
import { qlooApiKey } from "@/lib/qloo/config";
import { qlooQuota } from "@/lib/qloo/client";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requireSession } from "@/lib/session/require";

type RouteContext = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({
    lang: z.enum(["en", "es"]).optional(),
    locale: z.enum(["en", "es"]).optional(),
  })
  .nullable()
  .optional();

const unavailableBody = {
  error: "baseline_unavailable",
  en: "The LLM-only comparison is temporarily unavailable. Try again shortly.",
  es: "La comparación solo con LLM no está disponible por ahora. Inténtalo en un momento.",
};

function pinnedEntityIds(texts: string[]): string[] | null {
  const preset = PINNED_PRESETS.find(
    (entry) =>
      entry.seeds.length === texts.length &&
      entry.seeds.every((seed, index) => seed.rawText === texts[index]),
  );
  if (!preset) return null;
  const ids = preset.seeds.map((seed) => seed.entityId).filter((id): id is string => Boolean(id));
  return ids.length === preset.seeds.length ? ids : null;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const gate = await requireSession(request, id);
  if (gate instanceof NextResponse) return gate;

  try {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const parsed = bodySchema.safeParse(body.value ?? null);
    if (!parsed.success) return jsonError("invalid_body", 400);
    const requestedLocale = parsed.data?.lang ?? parsed.data?.locale ?? null;

    const session = await prisma.session.findUnique({
      where: { id },
      include: {
        seeds: { orderBy: { id: "asc" } },
        packs: { include: { items: true }, orderBy: { label: "asc" } },
      },
    });
    if (!session) return jsonError("not_found", 404);
    if (session.packs.length === 0) return jsonError("pack_empty", 409);

    if (requestedLocale && requestedLocale !== session.locale) {
      await prisma.session.update({
        where: { id },
        data: { locale: requestedLocale, lastActiveAt: new Date() },
      });
      session.locale = requestedLocale;
    }

    const locale = session.locale === "es" ? "es" : "en";
    const eventKind = session.eventKind ?? "tour";
    const texts = session.seeds.map((seed) => seed.rawText);
    const pinnedIds = pinnedEntityIds(texts);
    const entityIds =
      pinnedIds ??
      session.seeds
        .map((seed) => seed.resolvedEntityId)
        .filter((value): value is string => Boolean(value));
    if (entityIds.length === 0) return jsonError("no_anchors", 409);

    const { cardsSig, signature } = baselineSignature({
      entityIds,
      city: session.city,
      eventKind,
      locale,
      mode: "default",
    });

    const hit = await readBaselineCache(signature);
    if (hit) {
      const cheap = enforceRateLimit(request, "pack_cheap");
      if (cheap) return cheap;
      return NextResponse.json(
        { ...hit.payload, builtAt: hit.builtAt.toISOString() },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-DropQ-Cache": "hit",
          },
        },
      );
    }

    const limited = enforceRateLimit(request, "baseline_live");
    if (limited) return limited;
    if (qlooApiKey() && qlooQuota().blocked) {
      return NextResponse.json(unavailableBody, { status: 503 });
    }

    const isPreset = isPresetSession(session.seeds);
    const anchors = session.seeds.map((seed) => seed.resolvedName?.trim() || seed.rawText);
    const packIds = packEntityIdsBySlot(
      session.packs.map((pack) => ({
        label: pack.label,
        items: pack.items.map((item) => ({ slot: item.slot, qlooEntityId: item.qlooEntityId })),
      })),
    );

    const flight = beginBaselineFlight(signature, async () => {
      const again = await readBaselineCache(signature);
      if (again) return again;
      const built = await buildBaseline({
        cardsSig,
        locale,
        city: session.city,
        eventKind,
        anchors,
        packIdsBySlot: packIds,
      });
      if (!built.ok) {
        throw Object.assign(new Error(built.reason), { code: built.reason });
      }
      const written = await writeBaselineIfBetter({
        signature,
        cardsSig,
        locale,
        payload: built.payload,
        qlooCalls: built.qlooCalls,
        isPreset,
      });
      return { payload: built.payload, builtAt: written.builtAt };
    });

    try {
      const result = await flight.promise;
      return NextResponse.json(
        { ...result.payload, builtAt: result.builtAt.toISOString() },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-DropQ-Cache": flight.owner ? "miss" : "hit",
          },
        },
      );
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code === "unavailable" || code === "quota" || code === "llm_error") {
        return NextResponse.json(unavailableBody, { status: 503 });
      }
      throw error;
    }
  } catch (error) {
    return safeServerError(error, "baseline_failed");
  }
}

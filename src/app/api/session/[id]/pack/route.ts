import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { markLiveGeneration, refuseCustomLive } from "@/lib/abuse";
import { jsonError, readJsonBody, safeServerError } from "@/lib/http";
import {
  beginPackFlight,
  cachedStreamEvents,
  detectPresetFromPayload,
  materializeCachedPack,
  packCardsSignature,
  packSignature,
  readPackCache,
  siblingLocale,
  snapshotSessionPacks,
  writePackCache,
  writePackCacheIfBetter,
  type PackCachePayload,
} from "@/lib/pack/cache";
import { validateCrossLanguageParity, validatePack } from "@/lib/pack/validate";
import { observedQlooCalls, qlooQuota } from "@/lib/qloo/client";
import { qlooApiKey } from "@/lib/qloo/config";
import { QlooQuotaError } from "@/lib/qloo/types";
import { enforceRateLimit } from "@/lib/rate-limit";
import { PINNED_PRESETS } from "@/lib/pipeline/config";
import { relocalizeCachedPack, resolveOnly, runPipeline } from "@/lib/pipeline/run";
import { requireSession } from "@/lib/session/require";
import { packInputSchema } from "@/lib/session/schema";

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

type RouteContext = { params: Promise<{ id: string }> };

const quotaBody = {
  error: "QUOTA_LOW",
  en: "Live data is temporarily limited; try a preset.",
  es: "Los datos en vivo están limitados por ahora; prueba un preset.",
};

type Built = { payload: PackCachePayload; builtAt: Date };

function streamCached(packIds: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of cachedStreamEvents(packIds)) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      "X-DropQ-Cache": "hit",
    },
  });
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const gate = await requireSession(request, id);
  if (gate instanceof NextResponse) return gate;

  try {
    let requestedLocale: string | null = null;
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    if (body.value !== null) {
      const parsed = packInputSchema.safeParse(body.value);
      if (!parsed.success) return jsonError("invalid_body", 400);
      requestedLocale = parsed.data.lang ?? parsed.data.locale ?? null;
    }

    const session = await prisma.session.findUnique({
      where: { id },
      include: { seeds: { orderBy: { id: "asc" } } },
    });
    if (!session) return jsonError("not_found", 404);
    if (qlooApiKey() && qlooQuota().blocked) {
      return NextResponse.json(quotaBody, { status: 503 });
    }
    // A language toggle asks for the other stored row; follow it so the narration and the
    // UI chrome stay in the same language.
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
      (session.seeds.every((seed) => seed.resolvedEntityId)
        ? session.seeds.map((seed) => seed.resolvedEntityId!)
        : (await resolveOnly(id)).map((seed) => seed.entityId));
    const signature = packSignature({
      entityIds,
      city: session.city,
      eventKind,
      locale,
      mode: "default",
    });
    const cardsSig = packCardsSignature({
      entityIds,
      city: session.city,
      eventKind,
      mode: "default",
    });
    const otherLocale = siblingLocale(locale);
    const siblingSignature = packSignature({
      entityIds,
      city: session.city,
      eventKind,
      locale: otherLocale,
      mode: "default",
    });

    const hit = await readPackCache(signature);
    if (hit) {
      const cheap = enforceRateLimit(request, "pack_cheap");
      if (cheap) return cheap;
      const packIds = await materializeCachedPack(id, hit);
      return streamCached(packIds);
    }

    // Another language already chose the cards: narrate only (no Qloo, no new anchors).
    const sibling = await readPackCache(siblingSignature);
    if (sibling) {
      const cheap = enforceRateLimit(request, "pack_cheap");
      if (cheap) return cheap;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const emit = (event: unknown) => {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          };
          try {
            const flight = beginPackFlight(`${cardsSig}:narrate:${locale}`, id, async (): Promise<Built> => {
              const again = await readPackCache(signature);
              if (again) return again;
              const payload = await relocalizeCachedPack(id, sibling.payload, locale, emit);
              const isPreset = detectPresetFromPayload(payload);
              if (isPreset) {
                if (!validatePack(payload).ok) return { payload, builtAt: new Date() };
                const parity = validateCrossLanguageParity(sibling.payload, payload);
                if (!parity.ok) return { payload, builtAt: new Date() };
              }
              const written = await writePackCacheIfBetter({
                signature,
                payload,
                qlooCalls: 0,
                isPreset,
              });
              return { payload, builtAt: written.builtAt };
            });
            if (!flight.owner) {
              const built = await flight.promise;
              const packIds = await materializeCachedPack(id, built);
              for (const event of cachedStreamEvents(packIds)) emit(event);
            } else {
              await flight.promise;
            }
          } catch (error) {
            emit({
              step: "error",
              status: "error",
              detail: error instanceof QlooQuotaError ? "QUOTA_LOW" : "failed",
            });
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-store",
          "X-DropQ-Cache": "hit",
        },
      });
    }

    const limited = enforceRateLimit(request, "pack_live");
    if (limited) return limited;
    const resting = refuseCustomLive(session.seeds);
    if (resting) return resting;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event: unknown) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        try {
          const qlooBefore = observedQlooCalls();
          // Single-flight on the language-neutral cards key so concurrent EN/ES first
          // builds share one Qloo + anchor selection.
          const flight = beginPackFlight(cardsSig, id, async (): Promise<Built> => {
            const own = await readPackCache(signature);
            if (own) return own;
            const sib = await readPackCache(siblingSignature);
            if (sib) {
              const payload = await relocalizeCachedPack(id, sib.payload, locale, emit);
              const isPreset = detectPresetFromPayload(payload);
              if (isPreset && validatePack(payload).ok) {
                const parity = validateCrossLanguageParity(sib.payload, payload);
                if (parity.ok) {
                  const written = await writePackCacheIfBetter({
                    signature,
                    payload,
                    qlooCalls: 0,
                    isPreset,
                  });
                  return { payload, builtAt: written.builtAt };
                }
              }
              return { payload, builtAt: new Date() };
            }
            markLiveGeneration(session.seeds);
            await runPipeline(id, emit, request.signal);
            const snap = await snapshotSessionPacks(id);
            if (!snap) throw new Error("pack_empty");
            const isPreset = detectPresetFromPayload(snap);
            // Never store a preset that breaks product invariants; the session still
            // holds the built packs for this visitor.
            if (isPreset && !validatePack(snap).ok) {
              return { payload: snap, builtAt: new Date() };
            }
            const builtAt = await writePackCache({
              signature,
              payload: snap,
              qlooCalls: Math.max(0, observedQlooCalls() - qlooBefore),
              isPreset,
            });
            return { payload: snap, builtAt };
          });

          if (flight.owner) {
            await flight.promise;
          } else {
            const built = await flight.promise;
            if (built.payload.locale === locale) {
              const packIds = await materializeCachedPack(id, built);
              for (const event of cachedStreamEvents(packIds)) emit(event);
            } else {
              // Owner built the other language's cards; narrate ours from them.
              const payload = await relocalizeCachedPack(id, built.payload, locale, emit);
              const isPreset = detectPresetFromPayload(payload);
              if (isPreset && validatePack(payload).ok) {
                const parity = validateCrossLanguageParity(built.payload, payload);
                if (parity.ok) {
                  await writePackCacheIfBetter({
                    signature,
                    payload,
                    qlooCalls: 0,
                    isPreset,
                  });
                }
              }
            }
          }
        } catch (error) {
          emit({
            step: "error",
            status: "error",
            detail: error instanceof QlooQuotaError ? "QUOTA_LOW" : "failed",
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
        "X-DropQ-Cache": "miss",
      },
    });
  } catch (error) {
    if (error instanceof QlooQuotaError) {
      return NextResponse.json(quotaBody, { status: 503 });
    }
    return safeServerError(error, "pack_failed");
  }
}

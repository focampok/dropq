import { isPresetSession } from "@/lib/abuse";
import { prisma } from "@/lib/db";
import { openSessionCookie, readSessionCookie } from "@/lib/session/cookie";

export type BriefAccess =
  | { ok: true; sessionId: string; isPreset: boolean }
  | { ok: false; status: 404 };

/**
 * Preset packs are public. Custom packs require the signed session cookie that owns them.
 * Failures are always a generic 404 (no existence leak for private packs).
 */
export async function authorizeBriefAccess(
  packId: string,
  request: Request,
): Promise<BriefAccess> {
  const pack = await prisma.pack.findUnique({
    where: { id: packId },
    select: { sessionId: true },
  });
  if (!pack) return { ok: false, status: 404 };

  const session = await prisma.session.findUnique({
    where: { id: pack.sessionId },
    include: { seeds: { select: { rawText: true } } },
  });
  if (!session) return { ok: false, status: 404 };

  const isPreset = isPresetSession(session.seeds);
  if (isPreset) return { ok: true, sessionId: session.id, isPreset: true };

  const cookie = readSessionCookie(request);
  if (!cookie) return { ok: false, status: 404 };
  const sessionId = await openSessionCookie(cookie);
  if (!sessionId || sessionId !== session.id) return { ok: false, status: 404 };
  return { ok: true, sessionId: session.id, isPreset: false };
}

/** RSC/page variant: cookie string from next/headers. */
export async function authorizeBriefAccessFromCookie(
  packId: string,
  cookieValue: string | undefined,
): Promise<BriefAccess> {
  const pack = await prisma.pack.findUnique({
    where: { id: packId },
    select: { sessionId: true },
  });
  if (!pack) return { ok: false, status: 404 };

  const session = await prisma.session.findUnique({
    where: { id: pack.sessionId },
    include: { seeds: { select: { rawText: true } } },
  });
  if (!session) return { ok: false, status: 404 };

  const isPreset = isPresetSession(session.seeds);
  if (isPreset) return { ok: true, sessionId: session.id, isPreset: true };

  if (!cookieValue) return { ok: false, status: 404 };
  const sessionId = await openSessionCookie(cookieValue);
  if (!sessionId || sessionId !== session.id) return { ok: false, status: 404 };
  return { ok: true, sessionId: session.id, isPreset: false };
}

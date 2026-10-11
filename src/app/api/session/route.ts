import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { jsonError, readJsonBody, safeServerError } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";
import { resolveLocale } from "@/lib/i18n";
import { readCookie, sealSessionId, sessionCookie } from "@/lib/session/cookie";
import { createSessionSchema } from "@/lib/session/schema";

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "other");
  if (limited) return limited;

  try {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const parsed = createSessionSchema.safeParse(body.value);
    if (!parsed.success) return jsonError("invalid_body", 400);

    const locale =
      parsed.data.locale ?? resolveLocale(readCookie(request, "dropq_lang"));

    const session = await prisma.session.create({
      data: {
        city: parsed.data.city,
        eventKind: parsed.data.eventKind,
        locale,
        lastActiveAt: new Date(),
      },
    });
    const response = NextResponse.json(session);
    response.cookies.set(
      sessionCookie.name,
      await sealSessionId(session.id),
      sessionCookie.options,
    );
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === "SESSION_SECRET is not set") {
      return jsonError("server_error", 500);
    }
    return safeServerError(error, "session_create_failed");
  }
}

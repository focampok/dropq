import { NextResponse } from "next/server";
import { openSessionCookie, readSessionCookie } from "@/lib/session/cookie";

export async function requireSession(
  request: Request,
  idFromRoute: string,
): Promise<NextResponse | string> {
  const cookie = readSessionCookie(request);
  if (!cookie) return forbidden();
  const sessionId = await openSessionCookie(cookie);
  if (!sessionId || sessionId !== idFromRoute) return forbidden();
  return sessionId;
}

function forbidden(): NextResponse {
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}

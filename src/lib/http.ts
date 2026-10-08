import { NextResponse } from "next/server";

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

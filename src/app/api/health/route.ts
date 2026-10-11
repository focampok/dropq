import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkBootEnv } from "@/lib/env-check";
import { qlooApiKey } from "@/lib/qloo/config";
import { qlooQuota, search } from "@/lib/qloo/client";
import { geminiCallCount } from "@/lib/llm/gemini-chain";
import { observedQlooCalls } from "@/lib/qloo/client";
import { llmConfigured } from "@/lib/pipeline/llm";
import { QlooHttpError, QlooQuotaError } from "@/lib/qloo/types";
import { enforceRateLimit } from "@/lib/rate-limit";

export async function GET(request: Request) {
  checkBootEnv();
  const limited = enforceRateLimit(request, "other");
  if (limited) return limited;

  let db: "up" | "down" = "up";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    db = "down";
  }

  let qloo: "skipped_no_key" | "up" | "down" = "skipped_no_key";
  let qlooStatus: number | undefined;
  const quota = qlooQuota();

  if (qlooApiKey() && !quota.blocked) {
    try {
      await search({ query: "test", type: "urn:entity:movie" });
      qloo = "up";
    } catch (error) {
      qloo = "down";
      qlooStatus = error instanceof QlooHttpError ? error.status : error instanceof QlooQuotaError ? 503 : 0;
    }
  } else if (qlooApiKey() && quota.blocked) {
    qloo = "down";
  }

  const ok = db === "up" && (qloo === "skipped_no_key" || qloo === "up");
  const body: {
    ok: boolean;
    db: string;
    qloo: string;
    qlooStatus?: number;
    quota: { remaining?: number; blocked: boolean };
    llm: "on" | "off";
    geminiCalls: number;
    qlooCalls: number;
  } = {
    ok,
    db,
    qloo,
    quota,
    llm: llmConfigured() ? "on" : "off",
    geminiCalls: geminiCallCount(),
    qlooCalls: observedQlooCalls(),
  };
  if (qloo === "down" && qlooStatus !== undefined) body.qlooStatus = qlooStatus;

  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}

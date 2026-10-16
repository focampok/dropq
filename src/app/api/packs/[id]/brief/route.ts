import { NextResponse } from "next/server";
import { authorizeBriefAccess } from "@/lib/brief/access";
import { loadBrief } from "@/lib/brief/build";
import { jsonError, safeServerError } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";
import { resolveLocale } from "@/lib/i18n";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const limited = enforceRateLimit(request, "other");
  if (limited) return limited;

  try {
    const { id } = await context.params;
    if (!id?.trim()) return jsonError("not_found", 404);

    const access = await authorizeBriefAccess(id, request);
    if (!access.ok) return jsonError("not_found", 404);

    const url = new URL(request.url);
    const locale = resolveLocale(
      url.searchParams.get("lang") ?? url.searchParams.get("locale") ?? undefined,
    );
    const loaded = await loadBrief({ packId: id, locale });
    if (!loaded.ok) return jsonError("not_found", 404);

    const headers = new Headers({
      "Cache-Control": access.isPreset ? "public, max-age=60" : "private, no-store",
    });
    return NextResponse.json(loaded.payload, { headers });
  } catch (error) {
    return safeServerError(error, "brief_failed");
  }
}

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: vi.fn(async () => [{ ok: 1 }]) },
}));
vi.mock("@/lib/env-check", () => ({ checkBootEnv: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: vi.fn(() => null),
}));

describe("GET /api/health", () => {
  it("returns only ok-style data", async () => {
    const { GET } = await import("@/app/api/health/route");
    const response = await GET(new Request("http://localhost/api/health"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, db: "up" });
    expect(JSON.stringify(body)).not.toMatch(/QLOO|GEMINI|version|NODE_ENV/i);
  });
});

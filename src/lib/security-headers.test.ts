import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("security headers", () => {
  it("configures the required headers without CSP", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const rules = await nextConfig.headers?.();
    expect(rules?.[0]?.source).toBe("/:path*");
    const map = new Map((rules?.[0]?.headers ?? []).map((header) => [header.key, header.value]));
    expect(map.get("X-Content-Type-Options")).toBe("nosniff");
    expect(map.get("X-Frame-Options")).toBe("DENY");
    expect(map.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(map.get("Permissions-Policy")).toContain("camera=()");
    expect(map.get("Permissions-Policy")).toContain("microphone=()");
    expect(map.get("Permissions-Policy")).toContain("geolocation=()");
    expect(map.get("Permissions-Policy")).toContain("payment=()");
    expect(map.has("Content-Security-Policy")).toBe(false);
  });
});

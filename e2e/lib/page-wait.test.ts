import { describe, expect, it } from "vitest";
import { formatPackWaitFailure } from "./page";

describe("formatPackWaitFailure", () => {
  it("includes status, Retry-After, cache header and rate-limit UI", () => {
    const message = formatPackWaitFailure(
      "latin-tour-houston/en",
      {
        status: 429,
        cache: null,
        retryAfter: "30",
        rateLimitVisible: true,
      },
      "page.waitForResponse: Timeout 120000ms exceeded",
    );
    expect(message).toContain("latin-tour-houston/en");
    expect(message).toContain("last pack status=429");
    expect(message).toContain("Retry-After=30");
    expect(message).toContain("X-DropQ-Cache=absent");
    expect(message).toContain("rate-limit UI=yes");
  });

  it("reports none when no pack response was seen", () => {
    const message = formatPackWaitFailure(
      "roots-gt-la/en",
      { status: null, cache: null, retryAfter: null, rateLimitVisible: false },
      "Timeout exceeded",
    );
    expect(message).toContain("last pack status=none");
    expect(message).toContain("rate-limit UI=no");
  });
});

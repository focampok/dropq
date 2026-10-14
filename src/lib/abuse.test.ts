import { afterEach, describe, expect, it, vi } from "vitest";
import { demoRestingBody, refuseCustomLive } from "@/lib/abuse";

vi.mock("@/lib/qloo/client", () => ({
  qlooQuota: () => ({ remaining: 10_000, blocked: false }),
}));

vi.mock("@/lib/rate-limit", () => ({
  liveGenerationAllowed: () => true,
  noteLiveGeneration: () => undefined,
}));

const originalKey = process.env.QLOO_API_KEY;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalKey === undefined) delete process.env.QLOO_API_KEY;
  else process.env.QLOO_API_KEY = originalKey;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe("refuseCustomLive", () => {
  it("allows live builds without a key outside production (mocks path)", () => {
    process.env.NODE_ENV = "test";
    process.env.QLOO_API_KEY = "";
    expect(refuseCustomLive([{ rawText: "Custom Artist" }])).toBeNull();
    expect(
      refuseCustomLive([
        { rawText: "Ricardo Arjona" },
        { rawText: "Pollo Campero" },
        { rawText: "Gaby Moreno" },
      ]),
    ).toBeNull();
  });

  it("refuses every live build in production when the key is empty", async () => {
    process.env.NODE_ENV = "production";
    process.env.QLOO_API_KEY = "";
    const custom = refuseCustomLive([{ rawText: "Custom Artist" }, { rawText: "Other" }, { rawText: "Third" }]);
    expect(custom).not.toBeNull();
    expect(await custom!.json()).toEqual(demoRestingBody);
    expect(custom!.status).toBe(503);

    const preset = refuseCustomLive([
      { rawText: "Ricardo Arjona" },
      { rawText: "Pollo Campero" },
      { rawText: "Gaby Moreno" },
    ]);
    expect(preset).not.toBeNull();
    expect(await preset!.json()).toEqual(demoRestingBody);
  });
});

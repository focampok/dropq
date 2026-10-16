import { beforeEach, describe, expect, it, vi } from "vitest";
import { assembleBrief, countersClean } from "@/lib/brief/build";
import { evidenceLineFromStored } from "@/lib/brief/evidence";
import type { BriefPayload } from "@/lib/brief/types";
import { BASELINE_SLOTS } from "@/lib/baseline/types";

function sessionFixture(locale: "en" | "es" = "en") {
  return {
    id: "session_1",
    city: "Los Angeles",
    eventKind: "tour",
    locale,
    seeds: [
      {
        rawText: "Ricardo Arjona",
        resolvedName: "Ricardo Arjona",
        domain: "urn:entity:artist",
        resolvedEntityId: "seed-1",
      },
      {
        rawText: "Pollo Campero",
        resolvedName: "Pollo Campero",
        domain: "urn:entity:brand",
        resolvedEntityId: "seed-2",
      },
      {
        rawText: "Gaby Moreno",
        resolvedName: "Gaby Moreno",
        domain: "urn:entity:artist",
        resolvedEntityId: "seed-3",
      },
    ],
    packs: [
      {
        id: "pack_a",
        label: "A",
        axis: "root",
        narrative: "Roots night with [[watch]].",
        coverage: {
          notes: { en: "Coverage EN", es: "Coverage ES" },
          llm: { narrative: "llm", headline: "Roots headline", anchors: "llm" },
        },
        items: [
          {
            slot: "watch",
            hop: 0,
            qlooEntityId: "w1",
            qlooName: "Show One",
            qlooType: "urn:entity:tv_show",
            explain: "A show.",
            confidence: "high",
            evidence: { sharedTags: ["Latin"] },
            position: 0,
          },
          {
            slot: "listen",
            hop: 0,
            qlooEntityId: "l1",
            qlooName: "Artist One",
            qlooType: "urn:entity:artist",
            explain: "An artist.",
            confidence: "medium",
            evidence: { sharedTags: ["Pop"] },
            position: 1,
          },
          {
            slot: "wear",
            hop: 0,
            qlooEntityId: "r1",
            qlooName: "Brand One",
            qlooType: "urn:entity:brand",
            explain: "A brand.",
            confidence: "low",
            evidence: { hitTags: ["Apparel"] },
            position: 2,
          },
          {
            slot: "do",
            hop: 0,
            qlooEntityId: "d1",
            qlooName: "Place One",
            qlooType: "urn:entity:place",
            explain: "A place.",
            confidence: "medium",
            evidence: { chosenByCity: true },
            position: 3,
          },
        ],
      },
      {
        id: "pack_b",
        label: "B",
        axis: "bridge",
        narrative: null,
        coverage: {
          notes: { en: "Coverage EN", es: "Coverage ES" },
          llm: { narrative: "template", headline: "", anchors: "fallback" },
        },
        items: [
          {
            slot: "watch",
            hop: 1,
            qlooEntityId: "w2",
            qlooName: "Show Two",
            qlooType: "urn:entity:tv_show",
            explain: "Bridge show.",
            confidence: "medium",
            evidence: { sharedTags: ["Drama"] },
            position: 0,
          },
          {
            slot: "listen",
            hop: 1,
            qlooEntityId: "l2",
            qlooName: "Artist Two",
            qlooType: "urn:entity:artist",
            explain: "Bridge artist.",
            confidence: "high",
            evidence: { sharedTags: ["Rock"] },
            position: 1,
          },
          {
            slot: "wear",
            hop: 1,
            qlooEntityId: "r2",
            qlooName: "Brand Two",
            qlooType: "urn:entity:brand",
            explain: "Bridge brand.",
            confidence: "medium",
            evidence: { sharedTags: ["Streetwear"] },
            position: 2,
          },
          {
            slot: "do",
            hop: 1,
            qlooEntityId: "d2",
            qlooName: "Place Two",
            qlooType: "urn:entity:place",
            explain: "Bridge place.",
            confidence: "unverified",
            evidence: null,
            position: 3,
          },
        ],
      },
    ],
  };
}

function baselineFixture(): BriefPayload["baseline"] {
  return {
    cardsSig: "cards",
    locale: "en",
    llmItems: BASELINE_SLOTS.map((slot) => ({ slot, name: `LLM ${slot}` })),
    verification: BASELINE_SLOTS.map((slot) => ({
      slot,
      status: "verified" as const,
      resolvedEntityId: `id-${slot}`,
      resolvedName: `LLM ${slot}`,
      inPack: slot === "watch",
    })),
    source: "llm",
    summary: { verified: 4, inPack: 1 },
  };
}

describe("brief assemble", () => {
  it("keeps section order and eight slots for EN and ES with identical card names", () => {
    const en = assembleBrief({
      packId: "pack_a",
      session: sessionFixture("en"),
      locale: "en",
      baseline: null,
    });
    const es = assembleBrief({
      packId: "pack_a",
      session: sessionFixture("es"),
      locale: "es",
      baseline: null,
    });
    expect(en.plans).toHaveLength(2);
    expect(es.plans).toHaveLength(2);
    expect(en.plans.flatMap((plan) => plan.items.map((item) => item.name))).toEqual(
      es.plans.flatMap((plan) => plan.items.map((item) => item.name)),
    );
    expect(en.plans.flatMap((plan) => plan.items)).toHaveLength(8);
    expect(en.coverageNote).toBe("Coverage EN");
    expect(es.coverageNote).toBe("Coverage ES");
    expect(en.plans[0]?.narrationSource).toBe("llm");
    expect(en.plans[1]?.narrationSource).toBe("template");
    expect(en.baseline).toBeNull();
  });

  it("includes a stored baseline only when provided", () => {
    const withBaseline = assembleBrief({
      packId: "pack_a",
      session: sessionFixture(),
      locale: "en",
      baseline: baselineFixture(),
    });
    expect(withBaseline.baseline?.summary.verified).toBe(4);
    const without = assembleBrief({
      packId: "pack_a",
      session: sessionFixture(),
      locale: "en",
      baseline: null,
    });
    expect(without.baseline).toBeNull();
  });

  it("marks template narration when coverage has no llm narrative", () => {
    const session = sessionFixture();
    session.packs[0]!.coverage = { notes: { en: "", es: "" } };
    const brief = assembleBrief({ packId: "pack_a", session, locale: "en", baseline: null });
    expect(brief.plans[0]?.narrationSource).toBe("template");
  });
});

describe("brief evidence line", () => {
  it("prefers shared tags, then city choice", () => {
    expect(evidenceLineFromStored({ sharedTags: ["Latin", "Pop"] }, "en")).toContain("Latin");
    expect(evidenceLineFromStored({ chosenByCity: true }, "en")).toMatch(/city/i);
  });
});

describe("brief counters", () => {
  it("accepts unchanged qloo/gemini counters and zero writes", () => {
    expect(
      countersClean({
        qlooBefore: 3,
        geminiBefore: 1,
        qlooAfter: 3,
        geminiAfter: 1,
        writes: 0,
      }),
    ).toBe(true);
    expect(
      countersClean({
        qlooBefore: 3,
        geminiBefore: 1,
        qlooAfter: 4,
        geminiAfter: 1,
        writes: 0,
      }),
    ).toBe(false);
  });
});

vi.mock("@/lib/db", () => {
  const packFindUnique = vi.fn();
  const sessionFindUnique = vi.fn();
  return {
    prisma: {
      pack: { findUnique: packFindUnique },
      session: { findUnique: sessionFindUnique },
      baselineRun: { findUnique: vi.fn().mockResolvedValue(null) },
    },
  };
});

vi.mock("@/lib/qloo/client", () => ({
  observedQlooCalls: vi.fn(() => 7),
}));

vi.mock("@/lib/llm/gemini-chain", () => ({
  geminiCallCount: vi.fn(() => 2),
}));

describe("brief load access and spend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 for an unknown pack id without spending", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.pack.findUnique).mockResolvedValue(null);
    const { loadBrief } = await import("@/lib/brief/build");
    const result = await loadBrief({ packId: "missing", locale: "en" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
    expect(countersClean(result.counters)).toBe(true);
  });

  it("loads a brief with zero qloo/gemini movement and no writes", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.pack.findUnique).mockResolvedValue({
      id: "pack_a",
      sessionId: "session_1",
    } as never);
    vi.mocked(prisma.session.findUnique).mockResolvedValue(sessionFixture() as never);
    const { loadBrief } = await import("@/lib/brief/build");
    const result = await loadBrief({ packId: "pack_a", locale: "en" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.plans.flatMap((plan) => plan.items)).toHaveLength(8);
      expect(countersClean(result.counters)).toBe(true);
    }
  });
});

vi.mock("@/lib/session/cookie", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session/cookie")>();
  return {
    ...actual,
    openSessionCookie: vi.fn(async (value: string) => (value === "owner-cookie" ? "session_custom" : null)),
    readSessionCookie: vi.fn((request: Request) => {
      const header = request.headers.get("cookie") ?? "";
      const match = /dropq_sid=([^;]+)/.exec(header);
      return match?.[1] ?? null;
    }),
  };
});

describe("brief access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows a preset pack without a session cookie", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.pack.findUnique).mockResolvedValue({
      id: "pack_a",
      sessionId: "session_1",
    } as never);
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      id: "session_1",
      seeds: [
        { rawText: "Ricardo Arjona" },
        { rawText: "Pollo Campero" },
        { rawText: "Gaby Moreno" },
      ],
    } as never);
    const { authorizeBriefAccess } = await import("@/lib/brief/access");
    const result = await authorizeBriefAccess("pack_a", new Request("http://localhost/brief"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.isPreset).toBe(true);
  });

  it("returns generic 404 for a custom pack without the owning cookie", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.pack.findUnique).mockResolvedValue({
      id: "pack_custom",
      sessionId: "session_custom",
    } as never);
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      id: "session_custom",
      seeds: [{ rawText: "UniqueAnchorAlpha" }, { rawText: "UniqueAnchorBeta" }, { rawText: "UniqueAnchorGamma" }],
    } as never);
    const { authorizeBriefAccess } = await import("@/lib/brief/access");
    const denied = await authorizeBriefAccess("pack_custom", new Request("http://localhost/brief"));
    expect(denied).toEqual({ ok: false, status: 404 });
    const allowed = await authorizeBriefAccess(
      "pack_custom",
      new Request("http://localhost/brief", { headers: { cookie: "dropq_sid=owner-cookie" } }),
    );
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.isPreset).toBe(false);
  });
});

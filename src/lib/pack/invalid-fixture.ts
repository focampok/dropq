const explain = {
  en: "Placeholder card. Real Qloo data arrives with the API key.",
  es: "Tarjeta de ejemplo. Los datos reales de Qloo llegan con la API key.",
};

function item(
  slot: "watch" | "listen" | "wear" | "do",
  entityId: string | undefined,
  hop: 0 | 1,
) {
  return {
    slot,
    ...(entityId === undefined ? {} : { entityId }),
    name: "Sample pick (MOCK)",
    type: "urn:entity:place",
    hop,
    imageUrl: null,
    affinity: null,
    explain,
    confidence: "unverified" as const,
    provenance: "mock" as const,
  };
}

export const invalidFixture = {
  sessionId: "invalid",
  city: "Houston",
  eventKind: "tour" as const,
  seeds: [],
  packs: [
    {
      label: "A" as const,
      axis: "root" as const,
      items: [
        item("watch", "", 0),
        item("listen", "   ", 0),
        item("wear", undefined, 0),
        item("do", "MOCK:place:shared", 0),
      ],
    },
    {
      label: "B" as const,
      axis: "bridge" as const,
      items: [
        item("watch", "MOCK:movie:only-bridge", 1),
        item("listen", "MOCK:artist:only-bridge", 1),
        item("wear", "MOCK:brand:only-bridge", 1),
        item("do", "MOCK:place:shared", 1),
      ],
    },
  ],
  coverage: { notes: { en: "", es: "" } },
};

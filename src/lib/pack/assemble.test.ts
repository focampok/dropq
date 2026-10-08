import { describe, expect, it } from "vitest";
import { assemblePack } from "@/lib/pack/assemble";
import fixture from "@/lib/pack/fixture.json";
import { invalidFixture } from "@/lib/pack/invalid-fixture";
import { stubPack } from "@/lib/pack/stub-pack";

function entityIds(pack: { items: { entityId: string }[] }) {
  return pack.items.map((item) => item.entityId);
}

describe("assemblePack", () => {
  it("leaves a valid pack unchanged", () => {
    const result = assemblePack(fixture);
    expect(result.packs).toEqual(fixture.packs);
    expect(result.coverage.notes).toEqual({ en: "", es: "" });
    expect(result.coverage.removedFromBridge).toEqual([]);
    expect(result.sessionId).toBe(fixture.sessionId);
    expect(result.city).toBe(fixture.city);
  });

  it("drops blank and missing ids and does not invent a replacement", () => {
    const result = assemblePack(invalidFixture);
    const root = result.packs.find((pack) => pack.axis === "root");
    expect(root?.items.map((item) => item.slot)).toEqual(["do"]);
    expect(entityIds(root!)).toEqual(["MOCK:place:shared"]);
    const allowed = new Set([
      "MOCK:place:shared",
      "MOCK:movie:only-bridge",
      "MOCK:artist:only-bridge",
      "MOCK:brand:only-bridge",
    ]);
    for (const pack of result.packs) {
      for (const item of pack.items) {
        expect(item.entityId.trim().length).toBeGreaterThan(0);
        expect(allowed.has(item.entityId)).toBe(true);
      }
    }
  });

  it("keeps a duplicated id on Roots and drops it from Bridge", () => {
    const result = assemblePack(invalidFixture);
    const root = result.packs.find((pack) => pack.label === "A");
    const bridge = result.packs.find((pack) => pack.label === "B");
    expect(entityIds(root!)).toContain("MOCK:place:shared");
    expect(entityIds(bridge!)).not.toContain("MOCK:place:shared");
    expect(result.coverage.removedFromBridge).toEqual(["MOCK:place:shared"]);
    expect(result.coverage.notes.en).toContain(
      "MOCK:place:shared stayed on Roots and was removed from Bridge.",
    );
    expect(result.coverage.notes.es).toContain(
      "MOCK:place:shared se quedó en Raíz y se quitó de Puente.",
    );
  });

  it("drops a do hit whose tags name lodging and does not invent a place", () => {
    const result = assemblePack({
      ...fixture,
      packs: fixture.packs.map((pack) => ({
        ...pack,
        items: pack.items.map((item) =>
          item.slot === "do"
            ? { ...item, evidence: { hitTags: ["Resort hotel", "Lodging"] } }
            : item,
        ),
      })),
    });
    for (const pack of result.packs) {
      expect(pack.items.some((item) => item.slot === "do")).toBe(false);
      expect(pack.items.some((item) => item.name.toLowerCase().includes("hotel"))).toBe(false);
    }
    expect(result.coverage.notes.en).toContain("Do is unverified.");
    expect(result.coverage.notes.es).toContain("Hacer no está verificado.");
  });

  it("omits an empty slot and records an unverified coverage note", () => {
    const result = assemblePack(invalidFixture);
    const root = result.packs.find((pack) => pack.axis === "root");
    expect(root?.items.some((item) => item.slot === "watch")).toBe(false);
    expect(result.coverage.notes.en).toContain("Roots Watch is unverified.");
    expect(result.coverage.notes.es).toContain("Raíz Ver no está verificado.");
    expect(result.coverage.notes.en).toContain("Bridge Do is unverified.");
    expect(result.coverage.notes.es).toContain("Puente Hacer no está verificado.");
  });

  it("exposes only assembled stub cards, each with an entity id", () => {
    expect(stubPack.packs.map((pack) => pack.label)).toEqual(["A", "B"]);
    const rootIds = new Set(
      stubPack.packs.find((pack) => pack.axis === "root")!.items.map((item) => item.entityId),
    );
    for (const pack of stubPack.packs) {
      expect(pack.items).toHaveLength(4);
      for (const item of pack.items) {
        expect(item.entityId.trim().length).toBeGreaterThan(0);
        expect(item.entityId.startsWith("MOCK:")).toBe(true);
        expect(item.affinity).toBeNull();
      }
    }
    for (const item of stubPack.packs.find((pack) => pack.axis === "bridge")!.items) {
      expect(rootIds.has(item.entityId)).toBe(false);
    }
  });
});

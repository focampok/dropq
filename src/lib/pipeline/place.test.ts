import { describe, expect, it, vi } from "vitest";
import { fillPlaceSlot, placeOmittedNote } from "@/lib/pipeline/place";
import { PLACE_RADIUS_FALLBACK_M } from "@/lib/pipeline/config";

const card = (entityId: string, tags: string[] = ["Live music"]) => ({ entityId, name: entityId, tags });

describe("place slot", () => {
  it("fills the slot after client-side exclusion when the first ten hits are all Roots ids", async () => {
    const roots = Array.from({ length: 10 }, (_, index) => card(`root-${index}`));
    const fresh = Array.from({ length: 10 }, (_, index) => card(`new-${index}`));
    const load = vi.fn(async () => [...roots, ...fresh]);

    const outcome = await fillPlaceSlot({
      load,
      rootsIds: new Set(roots.map((entry) => entry.entityId)),
      fallbackRadius: PLACE_RADIUS_FALLBACK_M,
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(outcome.retried).toBe(false);
    expect(outcome.cards.map((entry) => entry.entityId)).toEqual(fresh.map((entry) => entry.entityId));
    expect(outcome.attempt).toMatchObject({ raw: 20, named: 20, afterRoots: 10 });
  });

  it("retries once at the wider radius and stops there", async () => {
    const radii: (number | undefined)[] = [];
    const load = vi.fn(async (radius?: number) => {
      radii.push(radius);
      return radius === undefined ? [card("root-1")] : [card("far-1")];
    });

    const outcome = await fillPlaceSlot({
      load,
      rootsIds: new Set(["root-1"]),
      fallbackRadius: PLACE_RADIUS_FALLBACK_M,
    });

    expect(radii).toEqual([undefined, PLACE_RADIUS_FALLBACK_M]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(outcome.retried).toBe(true);
    expect(outcome.cards.map((entry) => entry.entityId)).toEqual(["far-1"]);
  });

  it("omits the slot and notes the stage counts and the retry when nothing is valid", async () => {
    const load = vi.fn(async () => [card("root-1"), card("lodging-1", ["Hotel"])]);

    const outcome = await fillPlaceSlot({
      load,
      rootsIds: new Set(["root-1"]),
      fallbackRadius: PLACE_RADIUS_FALLBACK_M,
    });

    expect(outcome.cards).toEqual([]);
    expect(outcome.retried).toBe(true);
    expect(outcome.attempt).toMatchObject({ raw: 2, afterLodging: 1, afterRoots: 0 });

    const note = placeOmittedNote(outcome.first, outcome.attempt, PLACE_RADIUS_FALLBACK_M);
    expect(note.en).toContain("2 raw hits");
    expect(note.en).toContain("1 after the lodging net");
    expect(note.en).toContain("0 after removing Roots ids");
    expect(note.en).toContain("Retried once at 40000 m");
    expect(note.es).toContain("Se reintentó una vez a 40000 m");
  });
});

import { describe, expect, it, vi } from "vitest";
import { fillPlaceSlot, placeFallbackNote, placeOmittedNote } from "@/lib/pipeline/place";
import { PLACE_CATEGORY_TAGS, PLACE_CATEGORY_TAGS_FALLBACK, PLACE_RADIUS_FALLBACK_M } from "@/lib/pipeline/config";
import { placeTagSets } from "@/lib/pipeline/requests";

const card = (entityId: string, tags: string[] = ["Live music"]) => ({ entityId, name: entityId, tags });

const PRIMARY = ["urn:tag:category:place:live_music_venue"];
const FALLBACK = ["urn:tag:category:place:comic_book_store"];

describe("place slot", () => {
  it("fills the slot after client-side exclusion when the first ten hits are all Roots ids", async () => {
    const roots = Array.from({ length: 10 }, (_, index) => card(`root-${index}`));
    const fresh = Array.from({ length: 10 }, (_, index) => card(`new-${index}`));
    const load = vi.fn(async () => [...roots, ...fresh]);

    const outcome = await fillPlaceSlot({
      load,
      rootsIds: new Set(roots.map((entry) => entry.entityId)),
      fallbackRadius: PLACE_RADIUS_FALLBACK_M,
      tagSets: [PRIMARY],
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(outcome.retried).toBe(false);
    expect(outcome.usedFallback).toBe(false);
    expect(outcome.cards.map((entry) => entry.entityId)).toEqual(fresh.map((entry) => entry.entityId));
    expect(outcome.attempt).toMatchObject({ raw: 20, named: 20, afterRoots: 10 });
  });

  it("retries once at the wider radius and stops there", async () => {
    const radii: (number | undefined)[] = [];
    const load = vi.fn(async ({ radius }: { radius?: number }) => {
      radii.push(radius);
      return radius === undefined ? [card("root-1")] : [card("far-1")];
    });

    const outcome = await fillPlaceSlot({
      load,
      rootsIds: new Set(["root-1"]),
      fallbackRadius: PLACE_RADIUS_FALLBACK_M,
      tagSets: [PRIMARY],
    });

    expect(radii).toEqual([undefined, PLACE_RADIUS_FALLBACK_M]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(outcome.retried).toBe(true);
    expect(outcome.cards.map((entry) => entry.entityId)).toEqual(["far-1"]);
  });

  it("uses the second category set only when the first leaves the slot empty", async () => {
    const seen: string[][] = [];
    const load = vi.fn(async ({ radius, tags }: { radius?: number; tags: string[] }) => {
      seen.push(tags);
      if (tags === FALLBACK) return [card("comic-1")];
      return radius === undefined ? [card("root-1")] : [card("root-2")];
    });

    const outcome = await fillPlaceSlot({
      load,
      rootsIds: new Set(["root-1", "root-2"]),
      fallbackRadius: PLACE_RADIUS_FALLBACK_M,
      tagSets: [PRIMARY, FALLBACK],
    });

    expect(seen).toEqual([PRIMARY, PRIMARY, FALLBACK]);
    expect(outcome.usedFallback).toBe(true);
    expect(outcome.tagSetIndex).toBe(1);
    expect(outcome.cards.map((entry) => entry.entityId)).toEqual(["comic-1"]);
  });

  it("never touches the second set when the first one fills the slot", async () => {
    const load = vi.fn(async ({ tags }: { tags: string[] }) =>
      tags === PRIMARY ? [card("live-1")] : [card("comic-1")],
    );
    const outcome = await fillPlaceSlot({
      load,
      rootsIds: new Set(["root-1"]),
      fallbackRadius: PLACE_RADIUS_FALLBACK_M,
      tagSets: [PRIMARY, FALLBACK],
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(outcome.usedFallback).toBe(false);
    expect(placeFallbackNote(outcome.tagSetIndex)).toBeNull();
  });

  it("omits the slot and notes the stage counts, the retry, and both sets when nothing is valid", async () => {
    const load = vi.fn(async () => [card("root-1"), card("lodging-1", ["Hotel"])]);

    const outcome = await fillPlaceSlot({
      load,
      rootsIds: new Set(["root-1"]),
      fallbackRadius: PLACE_RADIUS_FALLBACK_M,
      tagSets: [PRIMARY, FALLBACK],
    });

    expect(outcome.cards).toEqual([]);
    expect(outcome.retried).toBe(true);
    expect(outcome.usedFallback).toBe(true);
    expect(outcome.attempt).toMatchObject({ raw: 2, afterLodging: 1, afterRoots: 0 });

    const note = placeOmittedNote(outcome.first, outcome.attempt, PLACE_RADIUS_FALLBACK_M, { sets: 2 });
    expect(note.en).toContain("2 raw hits");
    expect(note.en).toContain("1 after the lodging net");
    expect(note.en).toContain("0 after removing Roots ids");
    expect(note.en).toContain("across 2 category sets");
    expect(note.en).toContain("Last attempt at 40000 m");
    expect(note.es).toContain("en 2 conjuntos de categorías");
  });

  it("lists the second category set as tags that exist under urn:tag:category:place", () => {
    const sets = placeTagSets("con");
    expect(sets).toEqual([[...PLACE_CATEGORY_TAGS.con!], [...PLACE_CATEGORY_TAGS_FALLBACK.con!]]);
    expect(sets[1]!.every((tag) => tag.startsWith("urn:tag:category:place:"))).toBe(true);
    expect(sets[1]!.length).toBeGreaterThan(0);
  });
});

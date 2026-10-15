import { describe, expect, it } from "vitest";
import { WEAR_EXCLUDE_TAG_KEYWORDS } from "@/lib/pipeline/config";
import {
  TAG_PREVIEW_LIMIT,
  dedupeTags,
  filterSlotCards,
  isSeedFamilyName,
  normalizeSeedNames,
  tagPreview,
  wearCandidateExcluded,
  wearNameExcluded,
  wearTagsExcluded,
} from "@/lib/pipeline/tags";

const card = (name: string, tags: string[] = []) => ({ name, tags });

describe("tag hygiene", () => {
  it("keeps one copy of a repeated tag, ignoring case and surrounding space", () => {
    expect(dedupeTags(["Energetic", "energetic", " Energetic ", "Pop"])).toEqual([
      "Energetic",
      "Pop",
    ]);
    expect(dedupeTags(["  ", ""])).toEqual([]);
  });

  it("shows the first distinct tags and counts the rest", () => {
    const many = Array.from({ length: 13 }, (_, index) => `Tag ${index}`);
    const preview = tagPreview(many);
    expect(preview.shown).toHaveLength(TAG_PREVIEW_LIMIT);
    expect(preview.hidden).toBe(13 - TAG_PREVIEW_LIMIT);
    // Duplicates are removed before the cap, so they never eat preview slots.
    expect(tagPreview(["A", "a", "A", "B"]).shown).toEqual(["A", "B"]);
    expect(tagPreview(["A"]).hidden).toBe(0);
  });
});

describe("seed-family guard", () => {
  const seeds = normalizeSeedNames(["Nike", "Bad Bunny"]);

  it("matches a seed name only at a word boundary", () => {
    expect(isSeedFamilyName("Nike Training Club", seeds)).toBe(true);
    expect(isSeedFamilyName("Bad Bunny Radio", seeds)).toBe(true);
    expect(isSeedFamilyName("NIKE, Inc.", seeds)).toBe(true);
    expect(isSeedFamilyName("Puma", seeds)).toBe(false);
    expect(isSeedFamilyName("Badbunnyland", seeds)).toBe(false);
  });

  it("ignores seed names too short to match safely", () => {
    expect(normalizeSeedNames(["Ed", "Nike"])).toEqual(["nike"]);
  });

  it("drops the family from every slot and keeps the rest", () => {
    const result = filterSlotCards(
      "listen",
      [card("Nike Training Club"), card("Karol G"), card("Nike")],
      ["Nike"],
    );
    expect(result.cards.map((entry) => entry.name)).toEqual(["Karol G"]);
    expect(result.seedFamilyDropped).toEqual(["Nike Training Club", "Nike"]);
    expect(result.keptFallback).toBeNull();
  });

  it("keeps the best card and reports it rather than emptying the slot", () => {
    const result = filterSlotCards("wear", [card("Nike"), card("Nike Pro")], ["Nike"]);
    expect(result.cards.map((entry) => entry.name)).toEqual(["Nike", "Nike Pro"]);
    expect(result.seedFamilyDropped).toEqual([]);
    expect(result.keptFallback).toBe("seed_family");
  });
});

describe("wear exclusions", () => {
  it("reads the keyword list from config", () => {
    expect(WEAR_EXCLUDE_TAG_KEYWORDS).toContain("app");
    expect(WEAR_EXCLUDE_TAG_KEYWORDS).toContain("mobile app");
    expect(WEAR_EXCLUDE_TAG_KEYWORDS).toContain("streaming");
  });

  it("matches whole words, so 'app' never matches 'apparel'", () => {
    expect(wearTagsExcluded(["Apparel"])).toBe(false);
    expect(wearTagsExcluded(["Soft Goods", "Apparel"])).toBe(false);
    expect(wearTagsExcluded(["Mobile App"])).toBe(true);
    expect(wearTagsExcluded(["Video game"])).toBe(true);
    expect(wearTagsExcluded(["Soft drink"])).toBe(true);
    expect(wearTagsExcluded(["Ice Cream", "Dessert"])).toBe(true);
    expect(wearNameExcluded("Häagen-Dazs Ice Cream")).toBe(true);
  });

  it("fails closed when wear tags are unknown", () => {
    expect(wearCandidateExcluded({ name: "Mystery Brand", tags: [] })).toBe(true);
    expect(wearCandidateExcluded({ name: "Puma", tags: ["Apparel"] })).toBe(false);
  });

  it("drops non-wearables from wear only; empties wear rather than keeping a snack", () => {
    const candidates = [card("Nike Training Club app", ["Mobile app"]), card("Puma", ["Apparel"])];
    expect(
      filterSlotCards("wear", candidates, []).cards.map((entry) => entry.name),
    ).toEqual(["Puma"]);

    const listen = filterSlotCards("listen", [card("Netflix", ["Streaming"])], []);
    expect(listen.cards.map((entry) => entry.name)).toEqual(["Netflix"]);
    expect(listen.wearTagsDropped).toEqual([]);

    const allExcluded = filterSlotCards("wear", [card("Cheetos", ["Snack"])], []);
    expect(allExcluded.cards).toEqual([]);
    expect(allExcluded.keptFallback).toBe("wear_tags");
    expect(allExcluded.wearTagsDropped).toEqual(["Cheetos"]);

    const unknownTags = filterSlotCards("wear", [card("Häagen-Dazs", [])], []);
    expect(unknownTags.cards).toEqual([]);
    expect(unknownTags.wearTagsDropped).toEqual(["Häagen-Dazs"]);
  });
});

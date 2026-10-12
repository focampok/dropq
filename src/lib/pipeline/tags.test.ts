import { describe, expect, it } from "vitest";
import { TAG_PREVIEW_LIMIT, dedupeTags, tagPreview } from "@/lib/pipeline/tags";

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

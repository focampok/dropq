import { describe, expect, it } from "vitest";
import { sharesWordSequence, wordOverlapRatio, workedExampleText } from "@/lib/pipeline/copy-check";

describe("narration copy checks", () => {
  it("detects a shared 6-word sequence and ignores a 5-word echo", () => {
    const example = workedExampleText();
    expect(sharesWordSequence(example, "The Saturday farmers market opens with a brass band.")).toBe(true);
    expect(sharesWordSequence(example, "The Saturday farmers market opens later.")).toBe(false);
  });

  it("treats identical text as full overlap and a mostly different line as low overlap", () => {
    expect(wordOverlapRatio("alpha beta gamma", "alpha beta gamma")).toBe(1);
    expect(wordOverlapRatio("alpha beta gamma delta", "alpha other words here")).toBeLessThanOrEqual(0.6);
    expect(wordOverlapRatio("alpha beta gamma delta epsilon", "alpha beta gamma delta other")).toBeGreaterThan(0.6);
  });
});
import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { es } from "@/lib/i18n/es";
import { ENTITY_TYPE_KEYS } from "@/lib/i18n/types";

const dictionaries = { en, es } as const;

describe("entity type and hop labels", () => {
  it("names every Qloo entity type in both languages, without showing the URN", () => {
    for (const [locale, dictionary] of Object.entries(dictionaries)) {
      for (const key of ENTITY_TYPE_KEYS) {
        const label = dictionary.pack.entityTypes[key];
        expect(label, `${locale}:${key}`).toBeTruthy();
        expect(label).not.toContain("urn:");
      }
    }
    expect(en.pack.entityTypes.tv_show).not.toBe(es.pack.entityTypes.tv_show);
    expect(es.pack.entityTypes.tv_show).toBe("Serie");
    expect(en.pack.entityTypes.tv_show).toBe("TV show");
  });

  it("keeps the two hop phrasings, with the anchor name interpolated", () => {
    for (const dictionary of Object.values(dictionaries)) {
      expect(dictionary.pack.fromAnchors).toBeTruthy();
      expect(dictionary.pack.viaAnchor).toContain("{anchor}");
      expect(dictionary.pack.moreTags).toContain("{count}");
      expect(dictionary.pack.chosenForCityEvidence).not.toContain("—");
    }
    expect(es.pack.viaAnchor.replace("{anchor}", "Bad Bunny")).toBe("Vía Bad Bunny");
    expect(en.pack.viaAnchor.replace("{anchor}", "Bad Bunny")).toBe("Via Bad Bunny");
  });

  it("has no placeholder dash left in the pack dictionary", () => {
    for (const [locale, dictionary] of Object.entries(dictionaries)) {
      expect(dictionary.pack, locale).not.toHaveProperty("noAffinity");
    }
  });
});

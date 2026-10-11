import { z } from "zod";
import { CITY_VALUES, EVENT_KINDS } from "@/lib/presets";

/** Strip control characters and newlines, then trim. */
export function sanitizeSeedText(raw: string): string {
  return raw.replace(/[\u0000-\u001F\u007F\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

const seedText = z
  .string()
  .transform(sanitizeSeedText)
  .pipe(z.string().min(1).max(80));

export const createSessionSchema = z.object({
  city: z.enum(CITY_VALUES),
  eventKind: z.enum(EVENT_KINDS).optional(),
  locale: z.enum(["en", "es"]).optional(),
});

export const patchSessionSchema = z.object({
  city: z.enum(CITY_VALUES).optional(),
  eventKind: z.enum(EVENT_KINDS).optional(),
  locale: z.enum(["en", "es"]).optional(),
  timeWindow: z.unknown().optional(),
});

export const seedsSchema = z.object({
  seeds: z
    .array(
      z.object({
        rawText: seedText,
        source: z.enum(["text", "preset", "stt"]),
      }),
    )
    .min(3)
    .max(5),
});

export const refineSchema = z.object({
  mode: z.enum(["default", "deep_cuts"]),
});

/** Optional body on pack/resolve — city/kind/lang must match enums when present. */
export const packInputSchema = z
  .object({
    city: z.enum(CITY_VALUES).optional(),
    kind: z.enum(EVENT_KINDS).optional(),
    eventKind: z.enum(EVENT_KINDS).optional(),
    lang: z.enum(["en", "es"]).optional(),
    locale: z.enum(["en", "es"]).optional(),
    seeds: z
      .array(
        z.object({
          rawText: seedText,
          source: z.enum(["text", "preset", "stt"]).optional(),
        }),
      )
      .max(5)
      .optional(),
  })
  .passthrough();

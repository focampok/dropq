import { z } from "zod";
import { CITY_VALUES, EVENT_KINDS } from "@/lib/presets";

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
        rawText: z.string().trim().min(1).max(200),
        source: z.enum(["text", "preset", "stt"]),
      }),
    )
    .min(3)
    .max(5),
});

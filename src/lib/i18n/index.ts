import { en } from "@/lib/i18n/en";
import { es } from "@/lib/i18n/es";
import type { Dictionary } from "@/lib/i18n/types";

export type Locale = "en" | "es";

export function resolveLocale(value: string | undefined): Locale {
  return value === "es" ? "es" : "en";
}

export function getDictionary(locale: Locale): Dictionary {
  return locale === "es" ? es : en;
}

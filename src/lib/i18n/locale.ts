import { cookies } from "next/headers";
import { resolveLocale, type Locale } from "@/lib/i18n";

export async function readLocale(): Promise<Locale> {
  const jar = await cookies();
  return resolveLocale(jar.get("dropq_lang")?.value);
}

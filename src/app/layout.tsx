import type { Metadata } from "next";
import { Instrument_Serif, Outfit } from "next/font/google";
import { checkBootEnv } from "@/lib/env-check";
import { getDictionary } from "@/lib/i18n";
import { readLocale } from "@/lib/i18n/locale";
import "./globals.css";

checkBootEnv();

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
});

const instrument = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-instrument",
});

export async function generateMetadata(): Promise<Metadata> {
  const dictionary = getDictionary(await readLocale());
  return {
    title: dictionary.meta.title,
    description: dictionary.meta.description,
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await readLocale();
  return (
    <html lang={locale} className={`${outfit.variable} ${instrument.variable}`}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}

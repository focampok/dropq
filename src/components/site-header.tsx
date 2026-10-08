import Link from "next/link";
import { LanguageToggle } from "@/components/language-toggle";
import { getDictionary, type Locale } from "@/lib/i18n";

export function SiteHeader({ locale }: { locale: Locale }) {
  const dictionary = getDictionary(locale);
  return (
    <header className="flex items-center justify-between px-5 py-5 md:px-8">
      <Link href="/" className="font-serif text-2xl tracking-tight text-paper">
        {dictionary.brand}
      </Link>
      <LanguageToggle locale={locale} />
    </header>
  );
}

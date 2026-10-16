import { OnboardingForm } from "@/components/onboarding-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getDictionary } from "@/lib/i18n";
import { readLocale } from "@/lib/i18n/locale";

export default async function HomePage() {
  const locale = await readLocale();
  const dictionary = getDictionary(locale);

  return (
    <>
      <SiteHeader locale={locale} />
      <main className="mx-auto max-w-3xl px-5 pb-20 md:px-8">
        <p className="text-xs uppercase tracking-[0.22em] text-stamp">{dictionary.brand}</p>
        <h1 className="mt-3 max-w-2xl font-serif text-4xl leading-tight text-paper md:text-5xl">
          {dictionary.tagline}
        </h1>
        <p className="mt-4 max-w-xl text-base leading-relaxed text-paper/75">
          {dictionary.subline}
        </p>
        <div className="mt-8">
          <OnboardingForm locale={locale} />
        </div>
      </main>
      <SiteFooter locale={locale} />
    </>
  );
}

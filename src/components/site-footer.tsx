import { REPOSITORY_URL } from "@/lib/config";
import { getDictionary, type Locale } from "@/lib/i18n";

export function SiteFooter({ locale }: { locale: Locale }) {
  const dictionary = getDictionary(locale);
  return (
    <footer
      className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-5 py-6 text-xs text-paper/70 md:px-8 print:hidden"
      data-site-footer
    >
      <p>
        {dictionary.brand} · {dictionary.footer.license}
      </p>
      {REPOSITORY_URL ? (
        <a
          href={REPOSITORY_URL}
          className="underline decoration-paper/40 underline-offset-2 hover:text-paper"
        >
          {dictionary.footer.source}
        </a>
      ) : null}
    </footer>
  );
}

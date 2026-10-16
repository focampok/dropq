"use client";

import { useHydrated } from "@/components/hydration";
import { getDictionary, type Locale } from "@/lib/i18n";

export function BriefOpenLink({
  locale,
  packId,
}: {
  locale: Locale;
  packId: string | null;
}) {
  const dictionary = getDictionary(locale);
  const hydrated = useHydrated();
  const href = packId ? `/packs/${packId}/brief` : null;

  return (
    <a
      href={href ?? undefined}
      target="_blank"
      rel="noreferrer"
      data-brief-open
      aria-disabled={!hydrated || !href}
      className={`mt-4 inline-block rounded border border-paper/25 px-3 py-2 text-sm text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp ${
        !hydrated || !href ? "pointer-events-none opacity-50" : ""
      }`}
      onClick={(event) => {
        if (!hydrated || !href) event.preventDefault();
      }}
    >
      {dictionary.pack.openBrief}
    </a>
  );
}

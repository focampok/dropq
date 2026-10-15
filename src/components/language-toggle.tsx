"use client";

import { useRouter } from "next/navigation";
import { useHydrated } from "@/components/hydration";
import { getDictionary, type Locale } from "@/lib/i18n";

export function LanguageToggle({ locale }: { locale: Locale }) {
  const router = useRouter();
  const dictionary = getDictionary(locale);
  const hydrated = useHydrated();

  function choose(next: Locale) {
    if (next === locale) return;
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    document.cookie = `dropq_lang=${next}; Path=/; SameSite=Lax; Max-Age=31536000${secure}`;
    router.refresh();
  }

  return (
    <div
      role="group"
      aria-label={dictionary.language.label}
      className="flex items-center gap-1 text-sm"
    >
      <LangButton
        pressed={locale === "en"}
        onClick={() => choose("en")}
        label={dictionary.language.en}
        disabled={!hydrated}
      />
      <span aria-hidden="true" className="px-1 text-paper/50">
        |
      </span>
      <LangButton
        pressed={locale === "es"}
        onClick={() => choose("es")}
        label={dictionary.language.es}
        disabled={!hydrated}
      />
    </div>
  );
}

function LangButton({
  pressed,
  onClick,
  label,
  disabled,
}: {
  pressed: boolean;
  onClick: () => void;
  label: string;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-1.5 py-0.5 tracking-wide focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp disabled:pointer-events-none disabled:opacity-50 ${
        pressed ? "text-paper" : "text-paper/50 hover:text-paper"
      }`}
    >
      {label}
    </button>
  );
}

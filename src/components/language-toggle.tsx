"use client";

import { useRouter } from "next/navigation";
import { useHydrated } from "@/components/hydration";
import { getDictionary, type Locale } from "@/lib/i18n";

export function LanguageToggle({
  locale,
  tone = "stage",
}: {
  locale: Locale;
  /** `sheet` for light surfaces (brief); `stage` for the dark app chrome. */
  tone?: "stage" | "sheet";
}) {
  const router = useRouter();
  const dictionary = getDictionary(locale);
  const hydrated = useHydrated();

  function choose(next: Locale) {
    if (next === locale) return;
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    document.cookie = `dropq_lang=${next}; Path=/; SameSite=Lax; Max-Age=31536000${secure}`;
    router.refresh();
  }

  const muted = tone === "sheet" ? "text-ink/80" : "text-paper/50";
  const active = tone === "sheet" ? "text-ink font-medium" : "text-paper";
  const hover = tone === "sheet" ? "hover:text-ink" : "hover:text-paper";

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
        className={pressedClass(locale === "en", active, muted, hover)}
      />
      <span aria-hidden="true" className={`px-1 ${muted}`}>
        |
      </span>
      <LangButton
        pressed={locale === "es"}
        onClick={() => choose("es")}
        label={dictionary.language.es}
        disabled={!hydrated}
        className={pressedClass(locale === "es", active, muted, hover)}
      />
    </div>
  );
}

function pressedClass(pressed: boolean, active: string, muted: string, hover: string): string {
  return pressed ? active : `${muted} ${hover}`;
}

function LangButton({
  pressed,
  onClick,
  label,
  disabled,
  className,
}: {
  pressed: boolean;
  onClick: () => void;
  label: string;
  disabled: boolean;
  className: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-1.5 py-0.5 tracking-wide focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp disabled:pointer-events-none disabled:opacity-50 ${className}`}
    >
      {label}
    </button>
  );
}

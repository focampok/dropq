"use client";

import { useHydrated } from "@/components/hydration";

export function BriefPrintButton({ label }: { label: string }) {
  const hydrated = useHydrated();
  return (
    <button
      type="button"
      data-brief-print
      disabled={!hydrated}
      onClick={() => window.print()}
      className="rounded border border-ink/25 bg-sheet px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp disabled:pointer-events-none disabled:opacity-50 print:hidden"
    >
      {label}
    </button>
  );
}

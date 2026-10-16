import { BriefPrintButton } from "@/components/brief-print-button";
import { LanguageToggle } from "@/components/language-toggle";
import { Badge } from "@/components/ui/badge";
import type { BriefPayload } from "@/lib/brief/types";
import { REPOSITORY_URL } from "@/lib/config";
import { getDictionary, type Locale } from "@/lib/i18n";
import { BASELINE_SLOTS } from "@/lib/baseline/types";

export function BriefDocument({
  payload,
  locale,
}: {
  payload: BriefPayload;
  locale: Locale;
}) {
  const dictionary = getDictionary(locale);
  const when = formatWhen(payload.generatedAt, locale);
  const eventLabel =
    dictionary.eventKinds[payload.eventKind as keyof typeof dictionary.eventKinds] ??
    payload.eventKind;
  const cityLabel =
    Object.entries(dictionary.cities).find(([, label]) => label === payload.city)?.[1] ??
    payload.city;

  return (
    <article className="brief-doc mx-auto max-w-3xl bg-sheet px-5 py-8 text-ink md:px-8" data-brief>
      <header className="brief-chrome mb-6 flex flex-wrap items-start justify-between gap-4 print:hidden">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-ink/85">{dictionary.brand}</p>
          <h1 className="mt-1 font-serif text-3xl text-ink">{dictionary.brief.title}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <LanguageToggle locale={locale} tone="sheet" />
          <BriefPrintButton label={dictionary.brief.openPrint} />
        </div>
      </header>

      <header className="brief-print-header hidden print:block">
        <h1 className="font-serif text-2xl text-ink">{dictionary.brief.title}</h1>
      </header>

      <p className="mt-2 text-sm text-ink/90">
        {eventLabel} · {cityLabel} · {dictionary.brief.generated.replace("{when}", when)}
      </p>
      <p className="mt-2 text-sm text-ink/85">{dictionary.brief.privacyNote}</p>

      <section className="brief-section mt-8" aria-labelledby="brief-anchors">
        <h2 id="brief-anchors" className="text-xs font-medium uppercase tracking-[0.18em] text-ink">
          {dictionary.brief.anchorsHeading}
        </h2>
        <ul className="mt-3 space-y-2 text-sm">
          {payload.anchors.map((anchor) => (
            <li key={anchor.rawText}>
              <span className="font-medium">{anchor.rawText}</span>
              {anchor.resolvedName ? (
                <span className="text-ink/85">
                  {" "}
                  · {dictionary.pack.resolvedAs} {anchor.resolvedName}
                </span>
              ) : null}
              {anchor.unverified ? (
                <span className="ml-2 text-xs font-medium uppercase tracking-wide text-stamp-ink">
                  {dictionary.brief.unverified}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {payload.plans.map((plan) => (
        <section
          key={plan.label}
          className="brief-section mt-8"
          aria-labelledby={`brief-plan-${plan.label}`}
        >
          <h2 id={`brief-plan-${plan.label}`} className="font-serif text-2xl text-ink">
            {plan.label === "A" ? dictionary.brief.planRoots : dictionary.brief.planBridge}
          </h2>
          {plan.headline ? <p className="mt-1 text-base text-ink">{plan.headline}</p> : null}
          {plan.narrative ? (
            <p className="mt-2 text-sm text-ink/90">
              {plan.narrative}
              {plan.narrationSource === "llm" ? (
                <Badge className="ml-2 border-ink/40 bg-sheet text-ink">
                  {dictionary.pack.aiNarrative}
                </Badge>
              ) : (
                <span className="ml-2 text-xs font-medium uppercase tracking-wide text-ink/80">
                  {dictionary.brief.narrationTemplate}
                </span>
              )}
            </p>
          ) : null}

          <table className="brief-slot-table mt-4 w-full border-collapse text-sm">
            <caption className="sr-only">
              {plan.label === "A" ? dictionary.brief.planRoots : dictionary.brief.planBridge}
            </caption>
            <thead>
              <tr className="border-b border-ink/20 text-left text-xs font-medium uppercase tracking-wide text-ink">
                <th scope="col" className="py-2 pr-3">
                  {dictionary.pack.type}
                </th>
                <th scope="col" className="py-2 pr-3">
                  {dictionary.pack.name}
                </th>
                <th scope="col" className="py-2">
                  {dictionary.brief.evidenceHeading}
                </th>
              </tr>
            </thead>
            <tbody>
              {plan.items.map((item) => (
                <tr key={item.slot} className="brief-slot border-b border-ink/10 align-top" data-slot={item.slot}>
                  <th scope="row" className="py-3 pr-3 font-medium text-ink/85">
                    {dictionary.slots[item.slot]}
                  </th>
                  <td className="py-3 pr-3">
                    <p className="font-medium text-ink underline decoration-ink/40">{item.name}</p>
                    {item.explain ? <p className="mt-2 text-ink/90">{item.explain}</p> : null}
                  </td>
                  <td className="brief-evidence border-l border-ink/20 py-3 pl-3 text-ink/90">
                    {item.evidenceLine || dictionary.pack.confidenceValue[item.confidence]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <section className="brief-section mt-8" aria-labelledby="brief-how">
        <h2 id="brief-how" className="text-xs font-medium uppercase tracking-[0.18em] text-ink">
          {dictionary.brief.howToReadHeading}
        </h2>
        <p className="mt-3 text-sm text-ink/90">{dictionary.brief.howToRead}</p>
      </section>

      {payload.baseline ? (
        <section className="brief-section mt-8" aria-labelledby="brief-baseline" data-brief-baseline>
          <h2 id="brief-baseline" className="text-xs font-medium uppercase tracking-[0.18em] text-ink">
            {dictionary.brief.baselineHeading}
          </h2>
          <p className="mt-3 text-sm text-ink/90">
            {dictionary.pack.baselineSummary
              .replace("{verified}", String(payload.baseline.summary.verified))
              .replace("{inPack}", String(payload.baseline.summary.inPack))}
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {BASELINE_SLOTS.map((slot) => {
              const item = payload.baseline!.llmItems.find((entry) => entry.slot === slot);
              const verify = payload.baseline!.verification.find((entry) => entry.slot === slot);
              return (
                <li key={slot}>
                  <span className="text-ink/85">{dictionary.slots[slot]}:</span>{" "}
                  <span className="font-medium">{item?.name ?? "—"}</span>
                  <span className="ml-2 text-xs text-ink/85">
                    {verify?.status === "verified"
                      ? dictionary.pack.baselineVerified
                      : dictionary.pack.baselineNotVerifiable}
                    {verify?.inPack ? ` · ${dictionary.pack.baselineAlsoInPack}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <footer className="brief-section mt-10 border-t border-ink/20 pt-4 text-xs text-ink/85">
        {payload.coverageNote ? <p className="mb-2">{payload.coverageNote}</p> : null}
        <p>{dictionary.brief.poweredBy}</p>
        <p className="mt-1">{dictionary.brief.license}</p>
        {REPOSITORY_URL ? (
          <p className="mt-1">
            <a href={REPOSITORY_URL} className="underline">
              {dictionary.footer.source}
            </a>
          </p>
        ) : null}
      </footer>
    </article>
  );
}

function formatWhen(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === "es" ? "es-GT" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

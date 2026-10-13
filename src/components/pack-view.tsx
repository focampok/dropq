import { useState } from "react";
import { BookOpen, Headphones, Landmark, Shirt } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { getDictionary, type Locale } from "@/lib/i18n";
import {
  ENTITY_TYPE_KEYS,
  STEP_IDS,
  type EntityTypeKey,
  type StepId,
} from "@/lib/i18n/types";
import { SLOTS, type AssembledItem, type AssembledPack } from "@/lib/pack/assemble";
import { tagPreview } from "@/lib/pipeline/tags";

type SlotName = (typeof SLOTS)[number];

const SLOT_ICON: Record<SlotName, typeof BookOpen> = {
  watch: BookOpen,
  listen: Headphones,
  wear: Shirt,
  do: Landmark,
};

export function PackView({
  locale,
  pack,
  steps,
  anchors,
  narratives,
  headlines,
  aiNarrative,
  error,
  bridgeMode = "default",
  onBridgeMode,
  bridgeBusy = false,
  cacheNote = null,
}: {
  locale: Locale;
  pack: AssembledPack | null;
  steps?: Partial<Record<StepId, "pending" | "active" | "done" | "skipped" | "error">>;
  anchors?: { rawText: string; resolvedName: string | null; type: string }[];
  narratives?: { A?: string | null; B?: string | null };
  headlines?: { A?: string; B?: string };
  aiNarrative?: { A?: boolean; B?: boolean };
  error?: string | null;
  bridgeMode?: "default" | "deep_cuts";
  onBridgeMode?: (mode: "default" | "deep_cuts") => void;
  bridgeBusy?: boolean;
  cacheNote?: { label: string; exact: string } | null;
}) {
  const dictionary = getDictionary(locale);
  const note = pack?.coverage.notes[locale] ?? "";
  const mock = pack?.packs.some((plan) => plan.items.some((item) => item.provenance === "mock")) ?? false;

  return (
    <div className="mx-auto max-w-6xl px-5 pb-16 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-paper/50">{pack?.city}</p>
          <p className="mt-1 text-sm text-paper/70">
            {pack ? dictionary.eventKinds[pack.eventKind] : ""}
          </p>
        </div>
        {mock ? <Badge>{dictionary.pack.mockBadge}</Badge> : null}
      </div>

      {cacheNote ? (
        <p className="mt-3 text-xs text-paper/55" title={cacheNote.exact}>
          {cacheNote.label}
        </p>
      ) : null}

      {anchors && anchors.length > 0 ? (
        <ul className="mt-4 flex flex-wrap gap-2 text-sm text-paper/80">
          {anchors.map((anchor) => (
            <li key={anchor.rawText}>
              {anchor.rawText} {dictionary.pack.resolvedAs} {anchor.resolvedName ?? "—"} · {anchor.type}
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <p role="alert" className="mt-4 text-sm text-stamp">
          {error}
        </p>
      ) : null}

      <ol className="mt-6 flex flex-wrap gap-2">
        {STEP_IDS.map((stepId) => {
          const state = steps?.[stepId] ?? "pending";
          const label =
            state === "active"
              ? dictionary.pack.active
              : state === "done"
                ? dictionary.pack.stepDone
                : state === "skipped"
                  ? dictionary.pack.stepSkipped
                  : dictionary.pack.pending;
          return (
            <li
              key={stepId}
              data-step={stepId}
              data-state={state}
              className="min-w-36 flex-1 rounded-md border border-paper/15 bg-stage-raised px-3 py-2"
            >
              <p className="font-mono text-[10px] uppercase tracking-wide text-paper/40">{stepId}</p>
              <p className="mt-1 text-sm text-paper">{dictionary.pack.steps[stepId]}</p>
              <p className="text-xs text-paper/50">{label}</p>
            </li>
          );
        })}
      </ol>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {pack?.packs.map((plan) => (
          <section key={plan.label} aria-label={dictionary.plans[plan.label]}>
            <h2 className="font-serif text-3xl text-paper">
              <span className="mr-2 text-paper/40">{plan.label}</span>
              {dictionary.plans[plan.label]}
            </h2>
            {headlines?.[plan.label] ? (
              <p className="mt-1 text-lg text-paper/90">{headlines[plan.label]}</p>
            ) : null}
            {narratives?.[plan.label] ? (
              <p className="mt-2 text-sm text-paper/75">
                <span data-narrative-text>{narratives[plan.label]}</span>
                {aiNarrative?.[plan.label] ? (
                  <span
                    data-ai-badge
                    className="ml-2 inline-block rounded border border-paper/25 px-1.5 py-0.5 align-middle font-mono text-[10px] uppercase tracking-wide text-paper/60"
                    title={dictionary.pack.aiNarrativeHint}
                  >
                    {dictionary.pack.aiNarrative}
                  </span>
                ) : null}
              </p>
            ) : null}
            {plan.label === "B" && onBridgeMode ? (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={bridgeBusy}
                  aria-pressed={bridgeMode === "deep_cuts"}
                  onClick={() => onBridgeMode(bridgeMode === "deep_cuts" ? "default" : "deep_cuts")}
                  className="rounded-md border border-paper/20 px-3 py-1.5 text-sm text-paper hover:bg-paper/10 disabled:opacity-50"
                >
                  {dictionary.pack.deepCuts}
                </button>
                <p className="text-xs uppercase tracking-[0.14em] text-paper/50">
                  {bridgeMode === "deep_cuts" ? dictionary.pack.deepCutsOn : dictionary.pack.deepCutsOff}
                </p>
              </div>
            ) : null}
            <div className="mt-4 space-y-3">
              {SLOTS.map((slot) => {
                const item = plan.items.find((entry) => entry.slot === slot);
                if (!item) return null;
                return <PackCard key={`${plan.label}-${slot}`} item={item} locale={locale} />;
              })}
            </div>
          </section>
        ))}
      </div>

      {note ? (
        <p className="mt-8 text-sm text-paper/70">
          <span className="mr-2 uppercase tracking-[0.14em] text-paper/45">
            {dictionary.pack.coverage}
          </span>
          {note}
        </p>
      ) : null}
    </div>
  );
}

function PackCard({ item, locale }: { item: AssembledItem; locale: Locale }) {
  const dictionary = getDictionary(locale);
  const [broken, setBroken] = useState(false);
  const anchor = anchorOf(item);
  const cityChosen = item.evidence?.chosenByCity === true;
  const tags = tagsOf(item, "hitTags");
  const shared = cityChosen ? [] : tagsOf(item, "sharedTags");
  const explainability = explainOf(item);
  const prose = item.explain[locale]?.trim() ?? "";

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink/50">
            {dictionary.slots[item.slot]}
          </p>
          <h3 className="mt-1 text-lg font-medium">{item.name}</h3>
          {cityChosen ? (
            <p className="mt-1 text-xs uppercase tracking-[0.14em] text-ink/50">
              {dictionary.pack.chosenForCity}
            </p>
          ) : null}
        </div>
        {item.provenance === "mock" ? <Badge>{dictionary.pack.mockBadge}</Badge> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {prose ? (
          <div className="flex gap-3">
            <CardImage item={item} broken={broken} onBroken={() => setBroken(true)} locale={locale} />
            <p className="text-sm leading-relaxed text-ink/75">{prose}</p>
          </div>
        ) : null}
        <div className="rounded-md bg-ink/[0.04] p-3">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink/50">
            {dictionary.pack.whyQloo}
          </p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-ink/50">{dictionary.pack.name}</dt>
            <dd>{item.name}</dd>
            <dt className="text-ink/50">{dictionary.pack.type}</dt>
            <dd title={item.type}>{dictionary.pack.entityTypes[entityTypeKey(item.type)]}</dd>
            <dt className="text-ink/50">{dictionary.pack.entityId}</dt>
            <dd className="break-all font-mono text-xs">{item.entityId}</dd>
            <dt className="text-ink/50">{dictionary.pack.hop}</dt>
            <dd>{hopLabel(item, anchor, dictionary)}</dd>
            {item.affinity === null || item.affinity === undefined ? null : (
              <>
                <dt className="text-ink/50">{dictionary.pack.affinity}</dt>
                <dd>{item.affinity}</dd>
              </>
            )}
            <dt className="text-ink/50">{dictionary.pack.confidence}</dt>
            <dd>
              {dictionary.pack.confidenceValue[item.confidence]}
              {item.confidence === "low" ? (
                <span className="ml-2 uppercase tracking-[0.14em] text-stamp">
                  {dictionary.pack.weakSignal}
                </span>
              ) : null}
            </dd>
            {tags.length > 0 ? (
              <>
                <dt className="text-ink/50">{dictionary.pack.hitTags}</dt>
                <dd>
                  <TagList tags={tags} locale={locale} />
                </dd>
              </>
            ) : null}
            {shared.length > 0 ? (
              <>
                <dt className="text-ink/50">{dictionary.pack.sharedTags}</dt>
                <dd>
                  <TagList tags={shared} locale={locale} />
                </dd>
              </>
            ) : null}
            {anchor ? (
              <>
                <dt className="text-ink/50">{dictionary.pack.anchorEvidence}</dt>
                <dd>
                  {anchor.sharedTags.length > 0 ? (
                    <TagList tags={anchor.sharedTags} locale={locale} />
                  ) : null}
                </dd>
              </>
            ) : null}
            {explainability ? (
              <>
                <dt className="text-ink/50">{dictionary.pack.explainability}</dt>
                <dd className="break-all">{explainability}</dd>
              </>
            ) : null}
            {cityChosen ? (
              <>
                <dt className="text-ink/50">{dictionary.pack.chosenForCity}</dt>
                <dd>{dictionary.pack.chosenForCityEvidence}</dd>
              </>
            ) : null}
          </dl>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Long tag lists stay readable: the first few, then one control that reveals the rest.
 * The cap is display-only, so the count behind it is still the full distinct list.
 */
function TagList({ tags, locale }: { tags: string[]; locale: Locale }) {
  const dictionary = getDictionary(locale);
  const [expanded, setExpanded] = useState(false);
  const { shown: preview, hidden } = tagPreview(tags);
  const shown = expanded ? tags : preview;
  return (
    <span className="break-words">
      {shown.join(", ")}
      {hidden > 0 ? (
        <button
          type="button"
          data-tags-toggle
          onClick={() => setExpanded((value) => !value)}
          className="ml-1 rounded border border-line px-1.5 text-xs text-ink/60 hover:bg-ink/5"
        >
          {expanded
            ? dictionary.pack.lessTags
            : dictionary.pack.moreTags.replace("{count}", String(hidden))}
        </button>
      ) : null}
    </span>
  );
}

function entityTypeKey(type: string): EntityTypeKey {
  const suffix = type.includes(":") ? type.slice(type.lastIndexOf(":") + 1) : type;
  return (ENTITY_TYPE_KEYS as readonly string[]).includes(suffix) ? (suffix as EntityTypeKey) : "unknown";
}

function hopLabel(
  item: AssembledItem,
  anchor: { name: string } | null,
  dictionary: ReturnType<typeof getDictionary>,
): string {
  if (item.hop === 1 && anchor?.name) {
    return dictionary.pack.viaAnchor.replace("{anchor}", anchor.name);
  }
  return dictionary.pack.fromAnchors;
}

/**
 * Hotlinked Qloo images are not guaranteed to load, so every failure falls back to a
 * slot icon in a fixed 5:4 box instead of leaving a hole.
 */
function CardImage({
  item,
  broken,
  onBroken,
  locale,
}: {
  item: AssembledItem;
  broken: boolean;
  onBroken: () => void;
  locale: Locale;
}) {
  const dictionary = getDictionary(locale);
  const label = `${dictionary.slots[item.slot]} · ${dictionary.pack.noImage}`;
  if (item.imageUrl && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={item.imageUrl}
        alt=""
        width={80}
        height={100}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={onBroken}
        className="aspect-[4/5] w-20 shrink-0 rounded-md border border-line bg-ink/5 object-cover"
      />
    );
  }
  const Icon = SLOT_ICON[item.slot];
  return (
    <div
      role="img"
      aria-label={label}
      className="flex aspect-[4/5] w-20 shrink-0 items-center justify-center rounded-md border border-dashed border-line bg-ink/5"
    >
      <Icon aria-hidden className="h-6 w-6 text-ink/35" />
    </div>
  );
}

function anchorOf(
  item: AssembledItem,
): { name: string; sharedTags: string[]; confidence: string } | null {
  const anchor = item.evidence?.anchor;
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return null;
  const record = anchor as { name?: unknown; sharedTags?: unknown; confidence?: unknown };
  return {
    name: typeof record.name === "string" ? record.name : "",
    sharedTags: Array.isArray(record.sharedTags)
      ? record.sharedTags.filter((tag): tag is string => typeof tag === "string")
      : [],
    confidence: typeof record.confidence === "string" ? record.confidence : "",
  };
}

/** Only the tags that were actually stored; a missing row is not rendered at all. */
function tagsOf(item: AssembledItem, key: "hitTags" | "sharedTags"): string[] {
  const value = item.evidence?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function explainOf(item: AssembledItem): string {
  const value = item.evidence?.explainability;
  if (typeof value !== "string" || !value.includes(item.entityId)) return "";
  return value;
}

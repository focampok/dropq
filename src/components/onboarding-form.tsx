"use client";

import { Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getDictionary, type Locale } from "@/lib/i18n";
import {
  CITY_OPTIONS,
  DEMO_PRESETS,
  EVENT_KINDS,
  matchesPresetSeeds,
  presetSeedTexts,
  type CityValue,
  type EventKind,
} from "@/lib/presets";

const MIN_SEEDS = 3;
const MAX_SEEDS = 5;

export function OnboardingForm({ locale }: { locale: Locale }) {
  const router = useRouter();
  const dictionary = getDictionary(locale);
  const [city, setCity] = useState<CityValue>("Los Angeles");
  const [eventKind, setEventKind] = useState<EventKind>("tour");
  const [seeds, setSeeds] = useState<string[]>(["", "", ""]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function applyPreset(preset: (typeof DEMO_PRESETS)[number]) {
    setSeeds([...presetSeedTexts(preset)]);
    setCity(preset.city);
    setEventKind(preset.eventKind);
    setError(null);
  }

  function updateSeed(index: number, value: string) {
    setSeeds((current) => current.map((seed, i) => (i === index ? value : seed)));
    setError(null);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const texts = seeds.map((seed) => seed.trim()).filter(Boolean);
    if (texts.length < MIN_SEEDS || texts.length > MAX_SEEDS) {
      setError(dictionary.onboarding.needAnchors);
      return;
    }

    setSaving(true);
    setError(null);
    const source = matchesPresetSeeds(texts) ? "preset" : "text";

    try {
      const sessionResponse = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city, eventKind, locale }),
      });
      if (sessionResponse.status === 429) {
        setError(dictionary.onboarding.rateLimited);
        return;
      }
      if (!sessionResponse.ok) {
        setError(dictionary.onboarding.saveError);
        return;
      }
      const session = (await sessionResponse.json()) as { id?: string };
      if (!session.id) {
        setError(dictionary.onboarding.saveError);
        return;
      }

      const seedsResponse = await fetch(`/api/session/${session.id}/seeds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seeds: texts.map((rawText) => ({ rawText, source })),
        }),
      });
      if (seedsResponse.status === 429) {
        setError(dictionary.onboarding.rateLimited);
        return;
      }
      if (!seedsResponse.ok) {
        setError(dictionary.onboarding.saveError);
        return;
      }
      router.push(`/pack?session=${session.id}`);
    } catch {
      setError(dictionary.onboarding.saveError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-lg border border-line bg-sheet p-5 text-ink shadow-[0_24px_60px_rgba(0,0,0,0.28)] md:p-7"
    >
      <fieldset>
        <legend className="text-xs font-semibold uppercase tracking-[0.16em] text-ink/65">
          {dictionary.onboarding.presets}
        </legend>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {DEMO_PRESETS.map((preset) => {
            const texts = presetSeedTexts(preset);
            const active =
              seeds.length === texts.length &&
              texts.every((seed, index) => seeds[index] === seed) &&
              city === preset.city &&
              eventKind === preset.eventKind;
            return (
              <Button
                key={preset.id}
                type="button"
                variant={active ? "default" : "outline"}
                aria-pressed={active}
                onClick={() => applyPreset(preset)}
                className="h-auto min-h-16 whitespace-normal px-3 py-3 text-left"
              >
                {dictionary.presets[preset.id]}
              </Button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="mt-6">
        <legend className="text-xs font-semibold uppercase tracking-[0.16em] text-ink/65">
          {dictionary.onboarding.city}
        </legend>
        <div className="mt-3 flex flex-wrap gap-2">
          {CITY_OPTIONS.map((option) => (
            <Button
              key={option.id}
              type="button"
              size="sm"
              variant={city === option.value ? "default" : "outline"}
              aria-pressed={city === option.value}
              onClick={() => setCity(option.value)}
            >
              {dictionary.cities[option.id]}
            </Button>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-6">
        <legend className="text-xs font-semibold uppercase tracking-[0.16em] text-ink/65">
          {dictionary.onboarding.eventKind}
        </legend>
        <div className="mt-3 flex flex-wrap gap-2">
          {EVENT_KINDS.map((kind) => (
            <Button
              key={kind}
              type="button"
              size="sm"
              variant={eventKind === kind ? "default" : "outline"}
              aria-pressed={eventKind === kind}
              onClick={() => setEventKind(kind)}
            >
              {dictionary.eventKinds[kind]}
            </Button>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-6">
        <legend className="text-xs font-semibold uppercase tracking-[0.16em] text-ink/65">
          {dictionary.onboarding.anchors}
        </legend>
        <p className="mt-2 text-sm text-ink/65">{dictionary.onboarding.anchorsHint}</p>
        <div className="mt-3 space-y-2">
          {seeds.map((seed, index) => (
            <div key={index} className="flex items-center gap-2">
              <Label htmlFor={`anchor-${index}`} className="sr-only">
                {dictionary.onboarding.anchorLabel} {index + 1}
              </Label>
              <Input
                id={`anchor-${index}`}
                value={seed}
                placeholder={dictionary.onboarding.anchorPlaceholder}
                onChange={(event) => updateSeed(index, event.target.value)}
              />
              {index >= MIN_SEEDS ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSeeds((current) => current.filter((_, i) => i !== index))}
                >
                  <X aria-hidden="true" className="size-4" />
                  {dictionary.onboarding.removeAnchor}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
        {seeds.length < MAX_SEEDS ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => setSeeds((current) => [...current, ""])}
          >
            <Plus aria-hidden="true" className="size-4" />
            {dictionary.onboarding.addAnchor}
          </Button>
        ) : null}
      </fieldset>

      {error ? (
        <p role="alert" className="mt-4 text-sm text-stamp">
          {error}
        </p>
      ) : null}

      <Button type="submit" size="lg" className="mt-6 w-full" disabled={saving}>
        {saving ? dictionary.onboarding.saving : dictionary.onboarding.packNight}
      </Button>
    </form>
  );
}

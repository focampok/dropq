/**
 * A1–A5 (cached presets) and B1–B6 (evidence panel).
 *
 * One browser context per preset × language. The rendered DOM is cross-checked against
 * the app's own `/packs/latest` payload read through the same cookies, so a rendering
 * drift shows up as a mismatch rather than a silently different expectation.
 */
import type { BrowserContext, Page } from "playwright";
import {
  DO_EXCLUDE_TAG_KEYWORDS,
  PLACE_LODGING_TAG_WINDOW,
  PRESET_SEEDS,
  TAG_PREVIEW_LIMIT,
  cityLabel,
  confidenceForSharedTags,
  dict,
  isSeedFamilyName,
  kindLabel,
  normalizeSeedNames,
  presetLabel,
  wearTagsExcluded,
} from "../lib/app";
import { Acc, type Ctx } from "../lib/ctx";
import { BudgetAbort, nextForwarded, screenshotBoth } from "../lib/harness";
import {
  gotoHome,
  loadPreset,
  readLatest,
  scrape,
  scrollThrough,
  expandTagToggles,
  setLocaleCookie,
  waitForImages,
  waitForStreamDone,
  sentenceCount,
  type CardDom,
  type Latest,
  type LatestPlan,
  type SectionDom,
} from "../lib/page";

const PRESETS = ["roots-gt-la", "latin-tour-houston", "fandom-con-nyc"] as const;
const LOCALES = ["en", "es"] as const;
const PACK_BUTTON = /Pack the night|Armar la noche/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i;

type Row = CardDom["rows"][number];

function row(card: CardDom, label: string): Row | undefined {
  return card.rows.find((entry) => entry.label === label);
}

function sectionForLabel(dom: SectionDom[], label: string): SectionDom | undefined {
  return dom.find((section) => section.label === label);
}

function slotKey(card: CardDom, locale: "en" | "es"): string | null {
  const slots = dict(locale).slots as Record<string, string>;
  for (const [key, value] of Object.entries(slots)) if (value === card.slot) return key;
  return null;
}

function distinctLower(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const key = tag.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(tag.trim());
  }
  return out;
}

function duplicateTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const tag of tags) {
    const key = tag.trim().toLowerCase();
    if (seen.has(key)) dupes.push(tag.trim());
    seen.add(key);
  }
  return dupes;
}

export async function runPresetChecks(ctx: Ctx): Promise<void> {
  const accs: Record<string, Acc> = {
    A1: new Acc("A1", "Preset loads both plans in 4 slots within 1.5 s, cached note", "free"),
    A2: new Acc("A2", "Cards have ids, plans are disjoint, watch is TV, do has no lodging", "free"),
    A3: new Acc("A3", "wear is wearable and not the anchors' own family", "free"),
    A4: new Acc("A4", "Every image loads or shows the typed placeholder", "free"),
    A5: new Acc("A5", "Narration: badge, no tokens, <=2 sentences, ES grammar", "free"),
    B1: new Acc("B1", "Shared tags distinct; shown count equals the distinct list", "free"),
    B2: new Acc("B2", "do cards carry no shared-tags or anchor-evidence row", "free"),
    B3: new Acc("B3", "No rendered row with an empty or dash value", "free"),
    B4: new Acc("B4", "Hop line and friendly type labels are correct", "free"),
    B5: new Acc("B5", "Tag lists cap at 8 with a working +N more control", "free"),
    B6: new Acc("B6", "Confidence follows the shared-tag rule; weak signal on low", "free"),
  };

  for (const preset of PRESETS) {
    for (const locale of LOCALES) {
      if (ctx.llmSkipped === null) await ctx.qlooBuiltSince(ctx.runStart).then((n) => ctx.budget.setQlooBuilt(n)).catch(() => undefined);
      try {
        await onePreset(ctx, accs, preset, locale);
      } catch (error) {
        if (error instanceof BudgetAbort) throw error;
        const message = error instanceof Error ? error.message : String(error);
        for (const acc of Object.values(accs)) acc.fail(`${preset}/${locale}: ${message}`);
      }
    }
  }

  for (const acc of Object.values(accs)) acc.finish(ctx.recorder, 0);
}

async function onePreset(ctx: Ctx, accs: Record<string, Acc>, preset: string, locale: "en" | "es"): Promise<void> {
  const started = Date.now();
  const dictionary = dict(locale);
  const seeds = PRESET_SEEDS[preset] ?? [];
  let context: BrowserContext | null = null;
  const screenshots: string[] = [];
  try {
    context = await ctx.browser.newContext({
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { "x-forwarded-for": nextForwarded() },
    });
    await setLocaleCookie(context, ctx.base, locale);
    const page = await context.newPage();
    await gotoHome(page, ctx.base);
    const visibleMs = await loadPreset(page, ctx.base, presetLabel(locale, preset), PACK_BUTTON);
    await waitForStreamDone(page);

    // Cached note (A1): the app writes a relative "prepared" line for a cache hit.
    const noteText = await page.locator("p[title]").first().textContent().catch(() => null);

    const before = await scrape(page);
    await scrollThrough(page);
    await expandTagToggles(page);
    await scrollThrough(page);
    await waitForImages(page);
    const after = await scrape(page);
    const latest = await readLatest(page, ctx.base);
    screenshots.push(...(await screenshotBoth(page, `A-B-${preset}-${locale}`)));

    if (latest.plans.length !== 2) {
      for (const acc of Object.values(accs)) acc.fail(`${preset}/${locale}: latest returned ${latest.plans.length} plans`);
      return;
    }

    checkA1(accs.A1!, { preset, locale, visibleMs, noteText, before, dictionary });
    checkA2(accs.A2!, { preset, locale, before, latest, dictionary });
    checkA3(accs.A3!, { preset, locale, after, seeds });
    checkA4(accs.A4!, { preset, locale, after, dictionary });
    checkA5(accs.A5!, { preset, locale, before, latest, dictionary });
    checkB1(accs.B1!, { preset, locale, before, after });
    checkB2(accs.B2!, { preset, locale, after, dictionary });
    checkB3(accs.B3!, { preset, locale, after });
    checkB4(accs.B4!, { preset, locale, after, latest, dictionary });
    checkB5(accs.B5!, { preset, locale, before, after });
    checkB6(accs.B6!, { preset, locale, after, dictionary });

    for (const acc of Object.values(accs)) acc.pass(screenshots);
    void started;
    void page;
  } finally {
    await context?.close();
  }
}

type PlanSections = { A?: SectionDom; B?: SectionDom };

function byPlan(dom: SectionDom[], locale: "en" | "es"): PlanSections {
  const dictionary = dict(locale);
  return {
    A: sectionForLabel(dom, dictionary.plans.A),
    B: sectionForLabel(dom, dictionary.plans.B),
  };
}

function checkA1(
  acc: Acc,
  input: { preset: string; locale: "en" | "es"; visibleMs: number; noteText: string | null; before: SectionDom[]; dictionary: ReturnType<typeof dict> },
): void {
  const where = `${input.preset}/${input.locale}`;
  if (input.visibleMs > 1500) acc.fail(`${where}: pack visible in ${input.visibleMs} ms (>1500)`);
  const plans = byPlan(input.before, input.locale);
  for (const label of ["A", "B"] as const) {
    const section = plans[label];
    if (!section) {
      acc.fail(`${where}: plan ${label} section missing`);
      continue;
    }
    if (section.cards.length !== 4) acc.fail(`${where}: plan ${label} has ${section.cards.length} cards, expected 4`);
    const slots = new Set(section.cards.map((card) => slotKey(card, input.locale)).filter(Boolean));
    if (slots.size !== 4) acc.fail(`${where}: plan ${label} covers ${slots.size} slots, expected 4`);
  }
  const note = input.noteText ?? "";
  const label = input.dictionary.pack.cachedNote.replace("{when}", "").trim();
  if (!note.includes(label.replace(/·\s*$/, "").trim())) {
    acc.fail(`${where}: cached note missing (${JSON.stringify(note.slice(0, 80))})`);
  } else if (!/(just now|min ago|h ago|d ago|hace un momento|hace \d+ (min|h|d))/.test(note)) {
    acc.fail(`${where}: cached note has no relative time (${note.slice(0, 80)})`);
  }
}

function checkA2(
  acc: Acc,
  input: { preset: string; locale: "en" | "es"; before: SectionDom[]; latest: Latest; dictionary: ReturnType<typeof dict> },
): void {
  const where = `${input.preset}/${input.locale}`;
  const plans = byPlan(input.before, input.locale);
  const idsByPlan: Record<string, Set<string>> = { A: new Set(), B: new Set() };
  for (const label of ["A", "B"] as const) {
    const section = plans[label];
    if (!section) continue;
    for (const card of section.cards) {
      const idRow = row(card, input.dictionary.pack.entityId);
      const value = idRow?.value.trim() ?? "";
      if (!ID_RE.test(value)) acc.fail(`${where}: plan ${label} ${card.slot} has no entity id (${value.slice(0, 40)})`);
      idsByPlan[label]!.add(value.toUpperCase());
      const key = slotKey(card, input.locale);
      if (key === "watch") {
        const type = row(card, input.dictionary.pack.type)?.value.trim() ?? "";
        if (type !== input.dictionary.pack.entityTypes.tv_show) {
          acc.fail(`${where}: plan ${label} watch is not a TV show (type=${type})`);
        }
      }
      if (key === "do") {
        if (!card.chosenForCity) acc.fail(`${where}: plan ${label} do card is not marked chosen by the city`);
        const tags = (row(card, input.dictionary.pack.hitTags)?.tags ?? []).slice(0, PLACE_LODGING_TAG_WINDOW);
        const haystack = `${card.name} ${tags.join(" ")}`.toLowerCase();
        const hit = DO_EXCLUDE_TAG_KEYWORDS.find((word) => haystack.includes(word));
        if (hit) acc.fail(`${where}: plan ${label} do looks like lodging (${card.name} ~ ${hit})`);
      }
    }
  }
  const shared = [...idsByPlan.A!].filter((id) => idsByPlan.B!.has(id));
  if (shared.length > 0) acc.fail(`${where}: ${shared.length} id(s) appear in both plans`);
  // Cross-check the DOM ids against the API payload.
  const apiA = new Set(plans2Ids(input.latest, "A"));
  const apiB = new Set(plans2Ids(input.latest, "B"));
  if (plans.A && !sameSet(idsByPlan.A!, apiA)) acc.fail(`${where}: rendered plan A ids differ from the API payload`);
  if (plans.B && !sameSet(idsByPlan.B!, apiB)) acc.fail(`${where}: rendered plan B ids differ from the API payload`);
}

function plans2Ids(latest: Latest, label: "A" | "B"): string[] {
  const plan = latest.plans.find((entry) => entry.label === label);
  return (plan?.items ?? []).map((item) => item.entityId.toUpperCase());
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function checkA3(
  acc: Acc,
  input: { preset: string; locale: "en" | "es"; after: SectionDom[]; seeds: string[] },
): void {
  const where = `${input.preset}/${input.locale}`;
  const normalizedSeeds = normalizeSeedNames(input.seeds);
  const plans = byPlan(input.after, input.locale);
  const dictionary = dict(input.locale);
  for (const label of ["A", "B"] as const) {
    const section = plans[label];
    if (!section) continue;
    for (const card of section.cards) {
      if (slotKey(card, input.locale) !== "wear") continue;
      if (isSeedFamilyName(card.name, normalizedSeeds)) {
        acc.fail(`${where}: plan ${label} wear is the anchors' own family (${card.name})`);
      }
      const tags = row(card, dictionary.pack.hitTags)?.tags ?? [];
      if (wearTagsExcluded(tags)) {
        acc.fail(`${where}: plan ${label} wear matched a non-wearable keyword (${card.name})`);
      }
    }
    if (label === "B") {
      const lower = new Set(input.seeds.map((seed) => seed.toLowerCase()));
      for (const card of section.cards) {
        if (lower.has(card.name.toLowerCase())) acc.fail(`${where}: plan B card equals a seed (${card.name})`);
      }
    }
  }
}

function checkA4(
  acc: Acc,
  input: { preset: string; locale: "en" | "es"; after: SectionDom[]; dictionary: ReturnType<typeof dict> },
): void {
  const where = `${input.preset}/${input.locale}`;
  const plans = byPlan(input.after, input.locale);
  for (const label of ["A", "B"] as const) {
    const section = plans[label];
    if (!section) continue;
    for (const card of section.cards) {
      if (card.image.kind === "img" && !card.image.loaded) {
        acc.fail(`${where}: plan ${label} ${card.slot} image did not load and no placeholder replaced it`);
      }
      if (card.image.kind === "none") {
        acc.fail(`${where}: plan ${label} ${card.slot} shows neither an image nor a placeholder`);
      }
      if (slotKey(card, input.locale) === "do" && card.image.kind !== "placeholder") {
        acc.fail(`${where}: plan ${label} do card did not use the placeholder (${card.image.kind})`);
      }
    }
  }
}

function checkA5(
  acc: Acc,
  input: { preset: string; locale: "en" | "es"; before: SectionDom[]; latest: Latest; dictionary: ReturnType<typeof dict> },
): void {
  const where = `${input.preset}/${input.locale}`;
  const plans = byPlan(input.before, input.locale);
  const names = collectNames(input.before, input.latest);
  for (const label of ["A", "B"] as const) {
    const section = plans[label];
    if (!section) continue;
    const apiPlan = input.latest.plans.find((plan) => plan.label === label);
    const isLlm = apiPlan?.llm?.narrative === "llm";
    if (section.badge.present !== isLlm) {
      acc.fail(`${where}: plan ${label} badge=${section.badge.present} but stored narration is ${apiPlan?.llm?.narrative}`);
    }
    if (section.badge.present) {
      if (!section.badge.ownElement) acc.fail(`${where}: plan ${label} AI badge is not its own element`);
      if (section.badge.glued) acc.fail(`${where}: plan ${label} AI badge is glued to the text`);
      if (!(section.badge.leftMargin > 0)) acc.fail(`${where}: plan ${label} AI badge has no separating margin`);
    }
    const text = section.narrativeText ?? "";
    if (!text.trim()) {
      acc.fail(`${where}: plan ${label} has no narration`);
      continue;
    }
    if (text.includes("[[")) acc.fail(`${where}: plan ${label} narration leaks a [[token]]`);
    if (/https?:\/\/|www\./i.test(text)) acc.fail(`${where}: plan ${label} narration contains a URL`);
    if (sentenceCount(text) > 2) acc.fail(`${where}: plan ${label} narration has ${sentenceCount(text)} sentences`);
    if (input.locale === "es") {
      for (const name of names) {
        const pattern = new RegExp(`(^|[^\\p{L}])(al|del)\\s+${escapeRegExp(name)}`, "iu");
        if (pattern.test(text)) acc.fail(`${where}: plan ${label} Spanish text has an article before "${name}"`);
      }
    }
  }
}

function collectNames(dom: SectionDom[], latest: Latest): string[] {
  const names = new Set<string>();
  for (const section of dom) for (const card of section.cards) if (card.name) names.add(card.name);
  for (const anchor of latest.anchors) {
    if (anchor.rawText) names.add(anchor.rawText);
    if (anchor.resolvedName) names.add(anchor.resolvedName);
  }
  return [...names];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tagRowLabels(dictionary: ReturnType<typeof dict>): string[] {
  return [dictionary.pack.hitTags, dictionary.pack.sharedTags, dictionary.pack.anchorEvidence];
}

function checkB1(
  acc: Acc,
  input: { preset: string; locale: "en" | "es"; before: SectionDom[]; after: SectionDom[] },
): void {
  const where = `${input.preset}/${input.locale}`;
  const dictionary = dict(input.locale);
  const labels = tagRowLabels(dictionary);
  const beforePlans = byPlan(input.before, input.locale);
  const afterPlans = byPlan(input.after, input.locale);
  for (const label of ["A", "B"] as const) {
    const beforeSection = beforePlans[label];
    const afterSection = afterPlans[label];
    if (!beforeSection || !afterSection) continue;
    for (let index = 0; index < beforeSection.cards.length; index += 1) {
      const cardBefore = beforeSection.cards[index]!;
      const cardAfter = afterSection.cards[index]!;
      for (const rowLabel of labels) {
        const b = row(cardBefore, rowLabel);
        const a = row(cardAfter, rowLabel);
        if (!a || !b) continue;
        const dupes = duplicateTags(a.tags);
        if (dupes.length > 0) acc.fail(`${where}: plan ${label} ${cardAfter.slot} ${rowLabel} repeats ${dupes.join(", ")}`);
        const distinct = distinctLower(a.tags).length;
        if (b.tags.length > TAG_PREVIEW_LIMIT) {
          acc.fail(`${where}: plan ${label} ${cardAfter.slot} ${rowLabel} preview shows ${b.tags.length} (> ${TAG_PREVIEW_LIMIT})`);
        }
        if (b.hasToggle) {
          const hidden = distinct - b.tags.length;
          const shown = parseMoreCount(b.toggleLabel, input.locale);
          if (shown !== hidden) {
            acc.fail(`${where}: plan ${label} ${cardAfter.slot} ${rowLabel} control says ${b.toggleLabel}, list hides ${hidden}`);
          }
        }
      }
    }
  }
}

function parseMoreCount(label: string | null, locale: "en" | "es"): number | null {
  if (!label) return null;
  const pattern = locale === "es" ? /\+(\d+)\s*m[aá]s/i : /\+(\d+)\s*more/i;
  const match = label.match(pattern);
  return match ? Number(match[1]) : null;
}

function checkB2(
  acc: Acc,
  input: { preset: string; locale: "en" | "es"; after: SectionDom[]; dictionary: ReturnType<typeof dict> },
): void {
  const where = `${input.preset}/${input.locale}`;
  const plans = byPlan(input.after, input.locale);
  for (const label of ["A", "B"] as const) {
    const section = plans[label];
    if (!section) continue;
    for (const card of section.cards) {
      if (slotKey(card, input.locale) !== "do") continue;
      if (!card.chosenForCity) continue;
      if (row(card, input.dictionary.pack.sharedTags)) acc.fail(`${where}: plan ${label} do has a shared-tags row`);
      if (row(card, input.dictionary.pack.anchorEvidence)) acc.fail(`${where}: plan ${label} do has an anchor-evidence row`);
    }
  }
}

function checkB3(
  acc: Acc,
  input: { preset: string; locale: "en" | "es"; after: SectionDom[] },
): void {
  const where = `${input.preset}/${input.locale}`;
  const plans = byPlan(input.after, input.locale);
  for (const label of ["A", "B"] as const) {
    const section = plans[label];
    if (!section) continue;
    for (const card of section.cards) {
      for (const entry of card.rows) {
        const value = entry.value.replace(entry.toggleLabel ?? "", "").trim();
        if (value.length === 0 || value === "—") {
          acc.fail(`${where}: plan ${label} ${card.slot} renders an empty row "${entry.label}"`);
        }
      }
      if (card.prose !== null && card.prose.trim() === "—") {
        acc.fail(`${where}: plan ${label} ${card.slot} renders a dash-only description`);
      }
    }
  }
}

function checkB4(
  acc: Acc,
  input: { preset: string; locale: "en" | "es"; after: SectionDom[]; latest: Latest; dictionary: ReturnType<typeof dict> },
): void {
  const where = `${input.preset}/${input.locale}`;
  const plans = byPlan(input.after, input.locale);
  const roots = plans.A;
  const rootsNames = new Set((roots?.cards ?? []).map((card) => card.name));
  const fromAnchors = input.dictionary.pack.fromAnchors;
  const viaPattern = input.locale === "es" ? /^Vía\s+(.+)$/ : /^Via\s+(.+)$/;
  for (const label of ["A", "B"] as const) {
    const section = plans[label];
    if (!section) continue;
    for (const card of section.cards) {
      const type = row(card, input.dictionary.pack.type)?.value.trim() ?? "";
      if (type.includes("urn:entity:")) acc.fail(`${where}: plan ${label} ${card.slot} shows a raw URN type`);
      const hop = row(card, input.dictionary.pack.hop)?.value.trim() ?? "";
      const anchorRow = row(card, input.dictionary.pack.anchorEvidence);
      if (anchorRow) {
        const match = hop.match(viaPattern);
        if (!match) {
          acc.fail(`${where}: plan ${label} ${card.slot} has an anchor but hop reads "${hop}"`);
        } else if (!rootsNames.has(match[1]!.trim())) {
          acc.fail(`${where}: plan ${label} ${card.slot} names anchor "${match[1]}" which is not a Roots card`);
        }
      } else if (hop !== fromAnchors) {
        // A Bridge card whose slot had no anchor falls back to the same label by design.
        acc.fail(`${where}: plan ${label} ${card.slot} hop reads "${hop}", expected "${fromAnchors}"`);
      }
    }
  }
}

function checkB5(
  acc: Acc,
  input: { preset: string; locale: "en" | "es"; before: SectionDom[]; after: SectionDom[] },
): void {
  const where = `${input.preset}/${input.locale}`;
  const dictionary = dict(input.locale);
  const labels = tagRowLabels(dictionary);
  const beforePlans = byPlan(input.before, input.locale);
  const afterPlans = byPlan(input.after, input.locale);
  for (const label of ["A", "B"] as const) {
    const beforeSection = beforePlans[label];
    const afterSection = afterPlans[label];
    if (!beforeSection || !afterSection) continue;
    for (let index = 0; index < beforeSection.cards.length; index += 1) {
      const cardBefore = beforeSection.cards[index]!;
      const cardAfter = afterSection.cards[index]!;
      for (const rowLabel of labels) {
        const b = row(cardBefore, rowLabel);
        const a = row(cardAfter, rowLabel);
        if (!a || !b) continue;
        const distinct = distinctLower(a.tags).length;
        if (distinct > TAG_PREVIEW_LIMIT && !b.hasToggle) {
          acc.fail(`${where}: plan ${label} ${cardAfter.slot} ${rowLabel} has ${distinct} tags but no +N control`);
        }
        if (distinct <= TAG_PREVIEW_LIMIT && b.hasToggle) {
          acc.fail(`${where}: plan ${label} ${cardAfter.slot} ${rowLabel} has a +N control with only ${distinct} tags`);
        }
        if (b.hasToggle && a.tags.length !== distinct) {
          acc.fail(`${where}: plan ${label} ${cardAfter.slot} ${rowLabel} did not reveal all tags after expanding`);
        }
      }
    }
  }
}

function checkB6(
  acc: Acc,
  input: { preset: string; locale: "en" | "es"; after: SectionDom[]; dictionary: ReturnType<typeof dict> },
): void {
  const where = `${input.preset}/${input.locale}`;
  const plans = byPlan(input.after, input.locale);
  const weak = input.dictionary.pack.weakSignal;
  const values = input.dictionary.pack.confidenceValue;
  for (const label of ["A", "B"] as const) {
    const section = plans[label];
    if (!section) continue;
    for (const card of section.cards) {
      const shown = (row(card, input.dictionary.pack.confidence)?.value ?? "").replace(weak, "").trim();
      const anchorRow = row(card, input.dictionary.pack.anchorEvidence);
      const sharedRow = row(card, input.dictionary.pack.sharedTags);
      let expected: keyof typeof values;
      if (card.chosenForCity) {
        expected = "medium";
      } else if (anchorRow) {
        expected = confidenceForSharedTags(distinctLower(anchorRow.tags).length);
      } else if (sharedRow) {
        expected = confidenceForSharedTags(distinctLower(sharedRow.tags).length);
      } else {
        expected = "unverified";
      }
      if (shown !== values[expected]) {
        acc.fail(`${where}: plan ${label} ${card.slot} confidence "${shown}", rule says "${values[expected]}"`);
      }
      const hasWeak = card.rows.some((entry) => entry.value.includes(weak));
      const wantWeak = expected === "low";
      if (hasWeak !== wantWeak) {
        acc.fail(`${where}: plan ${label} ${card.slot} weak-signal marker shown=${hasWeak}, expected=${wantWeak}`);
      }
    }
  }
}

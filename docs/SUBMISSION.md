# DropQ — Devpost submission

## Inspiration

Community nights and diaspora events are still programmed by stereotype: “Latin night,” “anime con,” a familiar playlist. Organizers packing a night for a Guatemalan audience in Los Angeles, or an anime fandom in New York, need evidence of what that audience already loves and what the destination city can actually host. DropQ started from that gap: taste data exists, but organizers rarely get it as a plan they can print and use.

## What it does

An organizer declares **3–5 public cultural anchors**, a **destination city**, and an **event kind** (`tour`, `con`, or `comunidad` — shown as Tour / Con / Community in EN and Tour / Con / Comunidad in ES). DropQ returns two plans of four slots each:

- **Plan A — Roots:** stays close to what the audience already loves.
- **Plan B — Bridge:** one hop toward the destination city.

Slots are **watch**, **listen**, **wear**, and **do**. Every card carries a Qloo `entityId`.

DropQ is agentic by design: an LLM agent orchestrates the work (it picks Bridge anchors from a closed list of Qloo-backed candidates and narrates the result), while Qloo is the source of truth for every recommendation. Anchors are public cultural concepts; DropQ never asks for or infers personal data such as ethnicity, nationality or immigration status, and results are group-level affinities.

The UI is bilingual (EN/ES) with identical cards across languages. Deep cuts toggles `filter.popularity.max` (0.9) on Bridge `listen` / `watch` / `wear` only — Roots and the `do` slot are unchanged. “Why Qloo” shows stored affinity evidence. An optional **LLM-only comparison** sits beside the Qloo pack. A **printable brief** (`/packs/:id/brief`) renders the stored pack for organizers—no new API spend when opened.

## How we built it

- **Stack:** Next.js (App Router), Postgres (Prisma), Playwright e2e, deployed as a single Railway web service plus Railway Postgres.
- **Qloo:** search to resolve anchors; entity lookup for reference tags; insights across two hops (Roots then Bridge), with `signal.location.query` on Bridge media slots and `filter.exclude.entities` so Plan B ≠ Plan A. Own request limiter, monthly usage counter, and response caches.
- **LLM:** chooses Bridge anchors only from a closed ranked list and narrates with `[[tokens]]` the server substitutes. Template-first painting so a pack always appears; a provider chain (Gemini with fallbacks, optional Nebius) upgrades narration when quota allows. (A separate F7 path asks a tool-free model for free-text names to compare against Qloo.)
- **Presets:** six warmed rows (three presets × EN/ES) serve judges without live spend.
- **Safety:** validation before store, no mock entities in production, trusted-proxy-aware rate limits, security headers.

## How we use Qloo, concretely

Endpoints and parameters the pack pipeline actually calls:

1. **`GET /search`** — resolve seed text to entities (`query`, optional `type`).
2. **`GET /entities`** — reference tags for seeds (`entity_ids`); used for shared-tag confidence (search tags alone are not enough).
3. **`GET /v2/insights`** — fill each slot (`filter.type`, `signal.interests.entities`, optional `signal.location.query` on Bridge `listen`/`watch`/`wear`, `filter.exclude.entities` so Plan B ≠ Plan A on non-place slots, `filter.popularity.max` when Deep cuts is on, place geo via `filter.location` + radius, `filter.tags`, `feature.explainability`, `take`). Explainability is stored when present.

Client wrappers also exist for `/v2/tags` and `/v2/analysis/compare` (probes / future S2); the live pack path does not call them.

The LLM-only comparison (F7) reuses **`GET /search`** (at most four lookups) only to verify free-text LLM names against the graph; preset baselines are precomputed by `pnpm warm` and served from cache.

## Why Qloo matters here

Without Qloo, an LLM invents a night that sounds right and cannot show evidence for its picks. With Qloo, every card is a real entity, Roots and Bridge differ by construction, and shared tags / city choice become readable evidence. The **LLM-only vs With Qloo** panel (F7) makes that honest: it shows what a tool-free model suggests, which names resolve in Qloo, and which also appear in the real pack—without claiming unverified names are “wrong.”

## Reliability and safety

- Cached presets for the judge path; custom live builds refuse when monthly reserve (default 2000 remaining) or daily soft cap (default 250) is hit — user sees the demo-resting message. Per-IP / session limits return a rate-limit message; the LLM hourly soft cap (default 120) does not refuse the pack — it falls back to template narration.
- Quota guards on Qloo and Gemini; template narration when the model is unavailable.
- No mock data in production.
- Packs and baselines validated before write; language parity so EN/ES packs share the same entity ids.
- Trusted-proxy handling for client IP buckets; security headers including HSTS in production HTTPS.

## Challenges

- Insights tags from search vs entity lookup look similar but mean different things—shared-tag confidence only became meaningful after reading tags from `/entities`.
- Free-tier Gemini daily quotas per model forced template-first painting and a warm that can upgrade narration later without leaving a language missing.
- Keeping Plan A ≠ Plan B required exclusion in the insights query, not only post-assembly dedupe.
- Printable brief had to be a pure render of stored rows (zero Qloo/Gemini) while still matching the app’s evidence and AI markers.

## Accomplishments

- Two distinct Qloo-backed plans with four slots and `entityId` on every card.
- Bilingual UI with card parity; Deep cuts; Why Qloo evidence; LLM-only comparison with honest framing.
- Printable organizer brief (EN/ES, print CSS, preset-public / custom-private).
- Warmed presets + baseline column; prod e2e that aborts on any cache miss.
- Own limiter, monthly counter, and caches around Qloo.

## What we learned

Taste APIs repay careful parameter choice (`signal.location.query`, `filter.exclude.entities`) more than clever prompts. Template-first UX plus cached presets beats waiting on free-tier LLM quotas. Judges need a path that spends nothing; organizers need a brief they can print without regenerating the night.

## What's next

Audience bridge via analysis compare (scope S2), richer place filters (price / nostalgia where the API supports them), and multi-instance rate limits if the demo outgrows a single replica.

## Limitations and honesty

- Cultural coverage varies by city; some places lack images or dense tags.
- Unverified cards are labeled; group-level affinities are not personal predictions.
- Free-tier LLM quotas can force template narration until a warm upgrades the row.
- Soft caps and rate limits are in-memory for one instance.

## Built with

Next.js, React, TypeScript, Prisma, PostgreSQL, Tailwind CSS, Playwright, Qloo Taste API, Google Gemini (optional Nebius), Railway.

## Try it

- Demo: `<DEMO_URL>`
- Repository: the public DropQ GitHub repo (MIT).
- Steps: open a preset → toggle language → toggle Deep cuts → open “Why Qloo” → compare with LLM-only → open the brief → Print / Save as PDF.

# DropQ — Devpost submission

## Inspiration

Community nights and diaspora events are still programmed by stereotype: “Latin night,” “anime con,” a familiar playlist. An organizer packing a night for a Guatemalan audience in Los Angeles, or an anime fandom in New York, needs evidence of what that audience already loves and what the destination city can actually host. Taste data exists. It rarely arrives as a plan they can print and use.

## What it does

An organizer declares **3–5 public cultural anchors**, a **destination city**, and an **event kind** (Tour, Con, or Community; Tour, Con, or Comunidad in Spanish). DropQ returns two plans of four slots each:

- **Plan A — Roots:** stays close to what the audience already loves.
- **Plan B — Bridge:** a second pass aimed at the destination city.

Slots are **watch**, **listen**, **wear**, and **do**. Every stored card carries a Qloo `entityId`.

The server runs a fixed pipeline. The model does not call Qloo and does not choose which endpoint to hit. It makes two structured choices inside that pipeline: which two or three Roots cards become the Bridge anchors, and the sentences that connect the cards. Qloo remains the source of every recommendation. Anchors are public cultural names. DropQ does not ask for or infer ethnicity, nationality, or immigration status. Results are group-level affinities.

The UI is bilingual (EN/ES). Warmed English and Spanish rows share the same entity ids; only the narration changes. Deep cuts sets `filter.popularity.max` to `0.9` on Bridge `listen`, `watch`, and `wear` only. Roots and the `do` slot stay as they were. “Why Qloo” shows the stored evidence: shared tags, the hop, the entity id, and, for a place, that the city chose it. An optional **LLM-only comparison** sits beside the pack. A **printable brief** at `/packs/:id/brief` renders the stored pack. Opening it spends nothing.

## Potential impact

A volunteer programming a Guatemalan community night in Los Angeles opens the preset **Roots GT → LA** (Ricardo Arjona, Pollo Campero, Gaby Moreno, Community, Los Angeles). Roots is the lineup that stays with what that audience already recognizes. Bridge is the lineup aimed at the city: a show, an artist, a brand, and a venue, each a real Qloo entity. In the planning meeting they pick which plan to run, open Why Qloo when someone asks why a card is there, and print the brief for the venue or the group chat. The brief is the stored pack, so printing it does not generate the night again. The work they skip is building the evening from the label “Latin night.”

## How we built it

- **Stack:** Next.js (App Router), Postgres (Prisma), Playwright e2e, deployed as a single Railway web service plus Railway Postgres.
- **Qloo:** search resolves anchors; entity lookup supplies the reference tags confidence is measured against; insights fills Roots, then Bridge. Our client starts at most four requests a second, counts monthly usage, and caches responses.
- **Model:** two `generateObject` calls on a live build, described below. No tool list. A provider chain (Gemini, with fallbacks, and optional Nebius) runs when quota allows. The pack is stored with a template sentence first, so the cards appear before the narration call returns.
- **Presets:** six warmed rows (three presets × EN/ES), including the LLM-only comparison, so a judge path spends nothing.
- **Safety:** warmed preset rows and baseline comparisons are validated before they are written; an invalid preset is not stored. Production does not fabricate mock entities. Rate limits read the client IP through a trusted-proxy hop count. Security headers include HSTS when `NODE_ENV` is production.

## What the model decides

`runAgent` is an unimplemented stub. A live build always walks the same steps. The model is asked only at steps 5 and 8, and only for JSON.

1. **Resolve anchors.** `GET /search` for each seed (`query`, and `type` when the seed has one). Results are cached.
2. **Roots.** `GET /v2/insights` fills watch, listen, wear, and do from the resolved anchors. Watch asks for `urn:entity:tv_show`. If fewer than three named shows come back, the loader tries `urn:entity:movie`. A warmed preset still has to be a TV show or it is not stored.
3. **Reference tags.** `GET /entities?entity_ids=` loads the seeds’ genre and mood tags. Shared-tag confidence uses these, not the award and role tags that search returns. Cached.
4. **Closed list.** The server keeps the first remaining Roots card in watch, listen, and wear. Do is never an anchor. That list — at most three entities — is the only menu the model will see.
5. **Bridge anchors.** If a model is configured, the hourly cap allows it, Gemini is not already in quota cooldown, and the list has at least two ids, the server sends one structured call (6 second deadline). The schema is `{ "anchorIds": string[2..3], "reason": string }`. Every id must be on the list, and no two may share a slot. The server checks that. If the call is skipped, times out, hits quota, returns an id that is not on the list, repeats a slot, or fails schema, the server discards the reply and uses rule B: the strongest listen, the strongest wear, and watch only when it shares at least five tags with the seeds. Fewer than two ids falls through to a deterministic ranking of the same cards. The failure is stored on the pack. Hop 1 still runs.
6. **Bridge insights.** `GET /v2/insights` from those ids. On listen, watch, and wear the request sends `signal.location.query` for the destination city and `filter.exclude.entities` with the Roots ids, so Plan B does not repeat Plan A. Do does not send `filter.exclude.entities`. Both plans ask for a place in the city (`filter.location` as a WKT point, radius 20 km, one retry at 40 km) and drop Roots place ids after the response. The place is labeled as chosen for the city. Deep cuts adds `filter.popularity.max=0.9` on Bridge listen, watch, and wear only.
7. **Assemble and paint.** The server stores both plans with a template line (`Tonight: {names}.` / `Esta noche: {names}.`) and returns them. The page paints that row. It does not wait on the narration call for the cards.
8. **Narration.** One structured call (12 second deadline) asks for a headline and a line per plan. Where a name would go, the model must emit a token: `[[watch]]`, `[[listen]]`, `[[wear]]`, `[[do]]`, `[[city]]`, `[[anchor1]]` through `[[anchor3]]`. The server rejects an empty line, a line over 280 characters or two sentences, a headline over 60 characters (the prompt asks the model to stay within 40), a URL, an unknown or repeated token, a line that uses no token, a Spanish article glued to a token, or the wrong language. It allows one repair call that names the rejection. If that fails, the template stays and the failure is stored. Only a line that passes is written, and only then does the server substitute the real card names. The model never types the entity name that the pack displays.

If no anchor resolves, the later steps are skipped and the stored narrative is the empty template. A live build also stops at a 40 second budget and shows what it already has.

The **LLM-only comparison** is a separate request, not a step of the pack. A tool-free model returns one free-text name per slot. The server checks each name with `GET /search` (at most four calls) and labels it verified or not verifiable. A name that does not resolve is not called wrong. For the six preset rows this comparison is precomputed. A cache hit spends nothing. The comparison does not change the pack.

## How we use Qloo, concretely

Endpoints and parameters the pack pipeline calls:

1. **`GET /search`** — resolve seed text (`query`, optional `type`). The comparison reuses it, at most four times, to check free-text names.
2. **`GET /entities`** — reference tags for seeds (`entity_ids`).
3. **`GET /v2/insights`** — fill each slot. `filter.type` is `urn:entity:tv_show` (watch; movie only as the live fallback above), `urn:entity:artist` (listen), `urn:entity:brand` (wear), or `urn:entity:place` (do). `signal.interests.entities` carries the anchors on the media slots. Bridge listen, watch, and wear also send `signal.location.query`. Those same Bridge slots send `filter.exclude.entities` with the Roots ids. Deep cuts adds `filter.popularity.max=0.9` there. Place requests send `filter.tags`, `filter.location`, and `filter.location.radius` (20000, then 40000). `feature.explainability=true` is requested on the Roots hop only, and the text is stored when the response includes it. `take` is 10 for watch, listen, and wear, and 20 for place.

The client also wraps `/v2/tags` and `/v2/analysis/compare`. Probe and smoke scripts call them. The live pack path does not.

## Why Qloo matters here

Without Qloo, a model can name a night that sounds right and cannot show why a card is there. With Qloo, every stored card is an entity the API returned, Roots and Bridge are kept apart by the exclusion rule and the place filter, and shared tags or the city choice are readable on the card. The LLM-only panel shows what a tool-free model suggests, which names resolve in Qloo, and which of those also appear in the pack.

## Reliability and safety

- Cached presets serve the judge path. A custom live build is refused when remaining monthly requests fall below the reserve (default 2000) or the daily soft cap (default 250) is hit. The visitor sees the demo-resting message. Below 800 remaining, the client blocks new live Qloo calls outright. Presets and cached packs still load.
- Per-IP and per-session limits return a rate-limit message. The model’s hourly soft cap (default 120) does not refuse the pack. Anchor choice falls back to rule B and narration falls back to the template.
- Quota guards on Qloo and Gemini. An unavailable model leaves the template in place.
- Production does not serve mock entities.
- Warmed preset rows and baseline rows are validated before write. English and Spanish preset rows must share entity ids.
- Trusted-proxy handling for client IP buckets. Security headers include HSTS in production.

## Challenges

- Search tags and entity-lookup tags look similar and mean different things. Shared-tag confidence became meaningful only after reading tags from `/entities`.
- Free-tier Gemini daily quotas, per model, forced template-first painting and a warm step that can upgrade narration later without leaving a language missing.
- Keeping Plan A distinct from Plan B took `filter.exclude.entities` on the Bridge media queries. Deduping after assembly was not enough. Place does not accept that parameter, so Roots venues are dropped after the response, with a second category set when the first list is already used.
- The printable brief had to render stored rows only — no Qloo and no Gemini — and still show the same evidence and the same AI marker as the app.

## Accomplishments

- Two Qloo-backed plans, four slots each, with an `entityId` on every stored card.
- Bilingual UI with the same cards across languages, Deep cuts, Why Qloo evidence, and an LLM-only comparison that does not call an unverified name wrong.
- Printable organizer brief (EN/ES, print CSS). Presets are public. A custom pack’s brief is limited to the session that owns it.
- Pre-warmed presets, including the comparison, and an end-to-end suite that runs against production and stops if a preset is not a cache hit.
- Our own four-per-second limiter, monthly counter, and caches around Qloo.

## What we learned

The parameters (`signal.location.query`, `filter.exclude.entities`, the place radius) change the night more than a clever prompt does. A template sentence plus cached presets beats waiting on a free-tier model quota. Judges need a path that spends nothing. Organizers need a brief they can print without generating the night again.

## What's next

An audience bridge through `GET /v2/analysis/compare` (the client can call it; the live pack does not yet), richer place filters where the API supports them, and rate limits that survive more than one instance if the demo outgrows a single replica.

## Limitations and honesty

- Cultural coverage varies by city. Some places have no image or few tags.
- Unverified cards are labeled. Group-level affinities are not personal predictions.
- The `do` slot is chosen for the destination city. It is not a hop from the Bridge anchors.
- Free-tier model quotas can leave the template sentence in place until a later warm upgrades the stored row.
- Soft caps and rate limits live in memory on one instance.

## Built with

Next.js, React, TypeScript, Prisma, PostgreSQL, Tailwind CSS, Playwright, Qloo Taste API, Google Gemini (optional Nebius), Railway.

## Try it

- Demo: https://dropq.focampo.com
- Repository: the public DropQ GitHub repo (MIT).
- Steps: open **Roots GT → LA** → Pack the night → toggle language → toggle Deep cuts → read Why Qloo → Compare with an LLM-only answer → Open brief → Print / Save as PDF.

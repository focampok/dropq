# DropQ

DropQ packs a night for an audience and a city the way a promoter would. Name a few public cultural anchors, a destination, and an event kind; DropQ returns two plans of four Qloo-backed cards. Taste comes from Qloo; the LLM only picks Bridge anchors from a closed list and narrates with tokens.

**Live demo:** TBD

## Plans and slots

- **Plan A (Roots)** stays close to the audience anchors.
- **Plan B (Bridge)** reaches toward the destination city.
- Each plan has four slots: **watch** (TV shows), **listen**, **wear**, and **do** (no lodging).
- Every card carries a Qloo `entityId`. Deep cuts toggles a popularity filter on Bridge only and is idempotent.

## How Qloo is used

| Call | Role |
| --- | --- |
| Search | Resolve seed text to entities (cached). |
| Entities (`/entities?entity_ids=`) | The seeds' **reference tags** (cached 14 days). |
| Insights + explainability | Fill slots; explainability is stored when present. |
| Analysis | Supporting signals where the pipeline uses them. |

Bridge anchors are chosen from a **closed list** ranked by shared tags (rule B); the LLM may only re-order that list. Measured limits we work within: about **5 requests/second**, **10 000 requests/month**, no reliable per-item affinity score, and many places without images.

### Where shared tags come from

Shared tags are measured between a card's own tags and a **reference set**. The reference set for the seed anchors is read from the documented entity lookup, not from search: `/search` answers with award and role tags for an artist ("Grammy Award Winners", "Actor"), while the lookup answers with the same entity's genre and mood tags ("Reggaeton", "Latin Trap", "Energetic") — the ones the insights hits carry. Reading the seeds from search left Bad Bunny and J Balvin sharing only "Energetic". Cards' own tags always come from the insights response. Tags are compared case-insensitively and de-duplicated, so a tag repeated across a hit counts once.

### Confidence

One rule, in `src/lib/pipeline/config.ts` and applied to every card that has a reference set — Roots items against the seed anchors, Bridge items against the anchor that produced them:

| Distinct shared tags | Confidence |
| --- | --- |
| 3 or more | high |
| 2 | medium |
| 1 or none | low |

A Bridge card can never claim more than its own anchor, and a place the city chose is always `medium` with no shared-tag row at all. A card with no tags is `unverified`.

### Filters on the lists Qloo already returned

Both are client-side, so neither costs a request:

- **Seed family.** A candidate whose name contains a seed's name at a word boundary is the seed's own family, not a discovery — "Nike Training Club" for the seed "Nike". Seed names shorter than three characters are ignored.
- **`wear`.** A candidate whose tags mark it as not wearable is dropped: `mobile app`, `app`, `software`, `video game`, `gaming`, `console`, `beverage`, `soft drink`, `snack`, `food`, `restaurant`, `delivery`, `streaming`, `insurance`, `bank`, `airline`, `hotel`, `telecom`. Keywords match whole words, so `app` never matches `apparel`.

A filter never empties a slot: when it would, the best card the unfiltered list offered is kept and the reason is written into `coverage`.

### The Bridge and the destination city

The Bridge's hop-1 request for `listen`, `watch` and `wear` sends `signal.location.query=<destination city>`; Roots never does. `BRIDGE_USE_LOCATION` in `src/lib/pipeline/config.ts` records the decision per slot, taken from a probe that ran all three presets with and without the parameter. The list changes by 46–100%, the city list carries the destination's own scenes (Los Angeles answers with its Latin circuit and *Gentefied*; New York with Mitski and Rina Sawayama), and only the city list keeps the anchor's own family out of `wear`. One case reads slightly better without it — `watch` for the anime con — and the constant's comment says so.

## Where the LLM acts

- **Does:** pick 2–3 Bridge anchors from the closed list; write short narratives with `[[tokens]]` that the server substitutes.
- **Does not:** invent entities, scores, or places; override Qloo taste; run when the hourly soft cap is hit (template narration + rule B still produce a pack).

## Architecture

```
browser → Next.js API → Postgres (session, packs, caches)
                     ↘ Qloo (search / tags / insights)
                     ↘ Gemini (optional anchors + narration)
```

In-memory rate limits and soft caps assume a **single app instance**.

## Quick start

```bash
cp .env.example .env
# set DATABASE_URL and SESSION_SECRET (names only in the table below)
pnpm install
pnpm prisma migrate deploy
pnpm dev
```

Optional: `pnpm warm` prebuilds the three presets in English and Spanish into the pack cache (needs Qloo; the LLM is optional and upgrades the narration later). `pnpm warm --check` reports what is stored. `pnpm verify:local` exercises presets over HTTP against a running app.

**After the daily Gemini quota resets**, run `pnpm warm` once more: the six rows then hold LLM narration instead of the template, and an LLM row replaces a template row of the same signature. Until then `pnpm warm --check` reports `fail:template` for all six, which is expected and not an error.

The pack-cache signature includes `PIPELINE_VERSION` (`src/lib/pipeline/config.ts`), so changing how a pack is built makes every previously cached pack a miss. Bump it whenever the pipeline changes what a stored pack contains.


## Environment variables (names only)

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection |
| `SESSION_SECRET` | Signed session cookie |
| `QLOO_API_KEY` | Qloo hackathon key |
| `QLOO_BASE_URL` | Qloo API base |
| `LLM_DISABLED` | `true` / `1` kills the LLM for the process |
| `LLM_PROVIDER` | `google`, `nebius`, or empty |
| `GOOGLE_GENERATIVE_AI_API_KEY` / `GEMINI_API_KEY` | Gemini key |
| `GEMINI_MODEL` / `LLM_MODEL` | Principal model id |
| `GEMINI_FALLBACK_MODELS` | Comma-separated fallbacks |
| `GEMINI_RETRY_*` | Retry / backoff knobs |
| `NEBIUS_API_KEY` / `NEBIUS_BASE_URL` / `NEBIUS_MODEL` | Nebius provider |
| `TRUSTED_PROXY_HOPS` | X-Forwarded-For hops (default 1) |
| `QLOO_CUSTOM_RESERVE` | Soft reserve for custom packs |
| `QLOO_MONTHLY_LIMIT` | Contracted Qloo requests per month (default 10000) |
| `QLOO_USED_BASELINE` | Qloo requests spent before this deployment counted (default 0) |
| `LIVE_GENERATIONS_PER_DAY` | Soft daily live-generation cap |
| `LLM_CALLS_PER_HOUR` | Soft hourly Gemini cap |
| `PACK_CACHE_TTL_HOURS` | Ordinary pack-cache TTL (default 24h) |
| `PRESET_CACHE_TTL_HOURS` | Preset freshness window for warm/check (default 72; prod tip 720) |
| `DROPQ_LLM_BUDGET` | Per-process model-call cap (default uncapped) |
| `LOG_IP_PROBE` | `1` logs a five-request client-IP diagnostic (default off) |

## End-to-end tests

`pnpm e2e` drives the built app in a real Chromium and runs the whole checklist — the three
cached presets, the evidence panel, the live LLM path, Deep cuts, sessions, limits, language,
layout and the server surface — printing `PASS`, `FAIL` or `SKIP: <reason>` per check and
writing `docs/e2e/report.html`, `docs/e2e/summary.json`, `docs/e2e/run.log` and the
screenshots (all under the git-ignored `docs/`). The process exits non-zero when any check
fails; a SKIP is never a pass.

- **local** (default): builds if `.next` is missing, starts `next start` on port 3311 with
  the normal `.env`, runs every check (including the three custom live generations that
  spend Qloo and Gemini), then stops the server. It uses the local database and clears every
  pack-cache row except the six warmed presets, so a re-run is repeatable. The custom
  scenarios reuse the preset seeds with another allowed city, so seed resolution stays
  cached and only the insights are live.
- **prod**: `E2E_BASE_URL=https://<host> pnpm e2e -- --profile prod` runs only the
  `prod-safe` checks against a deployment. It starts no process and touches no local
  database, and it performs no live generation — only cached preset loads, which spend no
  Qloo or Gemini. Without `E2E_BASE_URL` the command prints `E2E_BASE_URL required` and
  exits non-zero without touching the network. Over `https` it also **requires**
  `Strict-Transport-Security` on `/` and `/api/health`; over `http` HSTS is only noted,
  because browsers ignore it there and the header is gated on `NODE_ENV=production`.
- `pnpm e2e:report` regenerates `report.html` and `summary.json` from the last run.

**Run the remote warm before a prod run.** A preset missing from `PackCache` fails A1 with
`preset not warm: run the remote warm` and a load time over 1.5 s — the intended signal that
the deployment's cache is cold, not a bug in the app.

The runner also cross-checks what was recorded against a manifest of every check id: a check
that reports nothing, an id outside the manifest, a duplicate id, or a SKIP carrying an
unexpected reason is turned into a FAIL, so nothing can pass by staying silent.

Cost is capped by counters that abort the expensive work: 45 Gemini calls and 70 Qloo
requests per run. Without a usable Chromium every browser check is `SKIP: no browser` and
the API-level checks still run; the suite uses the same browser `pnpm verify:ui` uses and
never downloads one.

## Deployment (Railway)

Two services: **this repository as one web service**, and the **native Railway Postgres**
(which provides `DATABASE_URL` for the web service). `railway.json` holds the commands, so
nothing has to be typed into the dashboard except the variables below.

```
build    pnpm build        # no database, no Qloo key and no Gemini key needed
pre-deploy  pnpm db:deploy # prisma migrate deploy; needs DATABASE_URL only, and is idempotent
start    pnpm start        # binds $PORT on 0.0.0.0
health   GET /api/health   # 200 {ok,db}; the healthcheck, 120 s timeout
```

On failure the service restarts, up to 10 times. The build needs no secret: `prisma generate`
runs in install/build and never opens a connection, so a first deploy can succeed before the
variables are filled in — but the app stops at boot, loudly and by name only, if
`DATABASE_URL` is absent or `SESSION_SECRET` is missing or shorter than 32 characters.

### Variables

Names only. Required means required in production; everything else has a working default and
can be left unset. `pnpm env:check` prints one status per name (never a value) and exits
non-zero on anything required-and-absent or invalid.

| Name | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | Postgres connection. Must not point at localhost in production. |
| `SESSION_SECRET` | yes | — | Session-cookie HMAC key, at least 32 characters. No fallback exists. |
| `QLOO_API_KEY` | yes | — | Qloo key. Without it the app still serves cached presets and answers live generation with the friendly "resting" message. |
| `QLOO_BASE_URL` | no | hackathon host | Qloo API base; must stay on the allowlisted host. |
| `QLOO_MONTHLY_LIMIT` | no | 10000 | Contracted monthly requests, for the usage guard. |
| `QLOO_USED_BASELINE` | no | 0 | Requests already spent on the same key before this deployment counted. |
| `QLOO_CUSTOM_RESERVE` | no | 2000 | Below this remaining, custom live builds are refused. |
| `TRUSTED_PROXY_HOPS` | no | 1 | Proxies appending to `X-Forwarded-For`. Railway adds one; leave it at 1. |
| `LIVE_GENERATIONS_PER_DAY` | no | 250 | Soft daily cap on uncached builds. |
| `LLM_CALLS_PER_HOUR` | no | 120 | Above this, narration falls back to the template. |
| `PACK_CACHE_TTL_HOURS` | no | 24 | Ordinary pack-cache TTL. |
| `PRESET_CACHE_TTL_HOURS` | no | 72 | Preset freshness for `pnpm warm --check`; recommended production value `720`. Stored presets are still served to visitors after expiry. |
| `LLM_PROVIDER` | no | inferred | `google` or `nebius`; empty infers Nebius when its three variables are set. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | see note | — | Gemini key. Required when the Google provider is in use; `GEMINI_API_KEY` is accepted instead. |
| `GEMINI_API_KEY` | no | — | Alternative Gemini key. |
| `GEMINI_MODEL` | see note | — | Chain principal; falls back to `LLM_MODEL`. No built-in default, so one of the two must be set. |
| `LLM_MODEL` | see note | — | Chain principal when `GEMINI_MODEL` is empty. |
| `GEMINI_FALLBACK_MODELS` | no | none | Comma-separated ids tried after the principal. |
| `GEMINI_RETRY_ATTEMPTS` / `GEMINI_RETRY_DELAY_MS` / `GEMINI_RETRY_MAX_DELAY_MS` | no | 3 / 1000 / 8000 | Retry and backoff knobs. |
| `NEBIUS_API_KEY` / `NEBIUS_BASE_URL` / `NEBIUS_MODEL` | see note | — | Required as a set when the Nebius provider is in use. |
| `DROPQ_LLM_BUDGET` | no | uncapped | Per-process model-call cap. |
| `LOG_IP_PROBE` | no | off | Temporary client-IP diagnostic; see below. |

Without any LLM credentials the app degrades on purpose: anchors use rule B and narration
uses the template, with `coverage.llm.off` naming the reason. That is a valid deployment.

**Leave the Google key and `GEMINI_MODEL` set for a public demo.** With `LLM_PROVIDER=google`
and no model id the boot check reports `MODEL_CHAIN invalid (no model)`.

### One instance

Rate limits, the daily generation cap and the LLM hourly cap are in-memory, so the service
must run a **single replica**. Two replicas would double every allowance and let a caller
half their own rate limit by reconnecting.

### Warm the presets before sharing the URL

A fresh database serves no preset from cache, so the first visitor's click would spend Qloo
and Gemini and take 8–20 s. Warm the six preset rows first, from a machine that can reach
the deployment's database:

```bash
# DATABASE_URL in the shell wins over .env; Qloo and Gemini keys still come from .env
DATABASE_URL='<the deployment connection string>' pnpm warm --confirm-remote
DATABASE_URL='<the deployment connection string>' pnpm warm --check --confirm-remote
```

`pnpm warm` refuses any non-local database unless `--confirm-remote` is passed, prints only
`local` or `remote` (never the host), and asks again on every run — so warming production by
accident is not possible. `--check` reads the six stored rows without spending anything and
exits non-zero if any is missing for the current `PIPELINE_VERSION` or still on template
narration; a stale-but-present row is a warning, not a failure. Re-run the remote warm after
any change that bumps `PIPELINE_VERSION`, and once more after the feature freeze.

Then verify the deployment itself:

```bash
E2E_BASE_URL=https://<host> pnpm e2e -- --profile prod
```

## Limitations

- Free-tier Qloo and Gemini quotas; the app refuses custom live packs when the monthly reserve or daily soft cap is hit (presets and cached packs keep working).
- Rate limits and soft caps are **in memory** for one instance.
- The `do` slot's lodging filter reads only the first eight tags of a place, because its keywords are substrings ("Innovation" and "Dinner" both contain "inn"). The pipeline's own count and the final check share that window.
- No Content-Security-Policy yet (Next inline scripts need nonces).

## License

MIT. See `LICENSE`.

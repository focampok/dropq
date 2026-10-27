# DropQ

DropQ turns 3–5 public cultural anchors and a destination city into two nights an organizer can print: Roots, close to the audience, and Bridge, aimed at the city.

**Live demo:** https://dropq.focampo.com

**Devpost:** DEVPOST_URL

**Try it in 30 seconds:** open the demo, click **Roots GT → LA**, then **Pack the night**. Look at Plan A (Roots) beside Plan B (Bridge): four cards each, every one a Qloo entity. Then open **Why Qloo** on a card.

Devpost paste text: [`docs/SUBMISSION.md`](docs/SUBMISSION.md).

## Features

- **Plan A (Roots)** / **Plan B (Bridge)** — four slots each: **watch**, **listen**, **wear**, **do**. Every card has a Qloo `entityId`.
- **Deep cuts** — popularity filter on Bridge only; idempotent.
- **Why Qloo** — stored shared tags / city-choice evidence, visually distinct from AI-written narration.
- **EN/ES** — language toggle; cards stay identical across languages.
- **LLM-only comparison** — tool-free LLM suggestions verified against Qloo search; preset baselines warmed into cache.
- **Printable brief** — `Open brief` → `/packs/:id/brief` (and `GET /api/packs/:id/brief`). Print / Save as PDF via `window.print()`; presets public, custom packs session-owner only. Pure render of stored data (no Qloo or Gemini calls).

## How Qloo is used

| Call | Role |
| --- | --- |
| Search (`/search`) | Resolve seed text to entities (cached); also verifies LLM-only names in the comparison. |
| Entities (`/entities?entity_ids=`) | The seeds' **reference tags** (cached). |
| Insights (`/v2/insights`) | Fill slots; optional `signal.location.query`, `filter.exclude.entities`; explainability stored when present. |

Bridge anchors are chosen from a **closed list**: the first kept Roots card in watch, listen, and wear. The model may return only ids from that list; otherwise the server keeps rule B. The client starts at most **4 requests/second**. Measured Qloo ceilings we work within: about **5 requests/second** and **10 000 requests/month**, no reliable per-item affinity score, and many places without images.

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

### LLM-only vs Qloo

On the pack page, **Compare with an LLM-only answer** asks a tool-free LLM for one name per slot (watch / listen / wear / do), then resolves each name with Qloo `/search` (≤4 searches). The panel shows **LLM only** and **With Qloo** side by side, with Verified / Not verifiable chips and which suggestions also appear in the real pack. Preset baselines are precomputed by `pnpm warm` and served as cache hits; the comparison never changes the pack.

## Architecture

```
browser ──► Next.js (App Router)
              │
              ├── /api/session…/pack     live / cached pack build
              ├── /api/packs/:id/brief   JSON brief (stored rows only)
              ├── /packs/:id/brief       printable brief page
              │
              ▼
           Postgres  (session, packs, PackCache, BaselineRun, Qloo caches)
              │
              ├──► Qloo   /search · /entities · /v2/insights
              └──► Gemini (optional Bridge pick + narration; template fallback)
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

Optional: `pnpm warm` prebuilds the three presets in English and Spanish into the pack cache (needs Qloo; the LLM is optional and upgrades the narration later). After each pack row is valid it also builds the LLM-only baseline comparison for that preset×language. `pnpm warm --check` reports what is stored (including a `baseline=` column); `--validate` fails when a pack or baseline is missing or malformed. `pnpm warm --check --validate` is the read-only gate used before share (expects 6/6 packs and 6/6 baselines, 0 violations, parity ok). Against a non-local database, pass `--confirm-remote` (prints only `remote`, never the host). `pnpm verify:local` exercises presets over HTTP against a running app.

Each row ends in exactly one of `cached` (a new LLM row was written), `kept` (the stored row is at least as good), `template` (written with the template narration, nothing better available) or `failed` (the build itself could not run), and the line always carries `reason=` and `attempts=` plus `baseline=cached|kept|failed` (with `reason=`). An LLM outage is not a `failed` pack row: the row is still written with the template and the reason names the cause (`quota_daily`, `quota_minute`, `timeout`, `llm_error`), so a warm run never leaves a language missing because the model was out of quota. A baseline failure never deletes or downgrades a valid pack.

- `pnpm warm --only <preset>[:en|:es]` (repeatable) limits the matrix to those rows.
- `pnpm warm --until-ok` repeats only the rows that are not yet `llm`, up to `--max-rounds` (default 4) times and never sooner than `--pause-s` (default 300, minimum 60). It exits 0 as soon as every selected row is `llm`; it stops early, non-zero, when every Gemini model is out of its daily quota (naming the reset time in Guatemala time) or when the Qloo remaining falls under the reserve.

**After the daily Gemini quota resets**, run `pnpm warm` (or `pnpm warm --until-ok`) once more: the six rows then hold LLM narration instead of the template, and an LLM row replaces a template row of the same signature. Until then `pnpm warm --check` reports `fail:template` for all six, which is expected and not an error.

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
| `NEXT_PUBLIC_REPOSITORY_URL` | Optional public repo URL for the MIT footer link (no hard-coded host in code) |

## End-to-end tests

`pnpm e2e` drives the built app in a real Chromium and runs the whole checklist — the three
cached presets, the evidence panel, the LLM-only vs Qloo baseline comparison, the
printable brief, the live LLM path, Deep cuts, sessions, limits, language, layout and
the server surface — printing `PASS`, `FAIL` or `SKIP: <reason>` per check and writing
`docs/e2e/report.html`,
`docs/e2e/summary.json`, `docs/e2e/run.log` and the screenshots (all under the git-ignored
`docs/`). The process exits non-zero when any check fails; a SKIP is never a pass.

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

**In the prod profile every preset load must be a cache hit.** The app answers a served
preset with `X-DropQ-Cache: hit`; if any preset load comes back without it, the suite prints
`ABORTED — <preset>/<language>: the pack response was not served from the stored cache` and
stops immediately, failing every check it had not reported yet with `aborted on a preset
cache miss`. The first such load is the only one that could have started a live build — the
abort exists so the other eleven cannot. A cold deployment therefore fails fast and loudly
instead of slowly and expensively.

**Run the remote warm before a prod run.** A preset missing from `PackCache` fails A1 with
`preset not warm: run the remote warm` and a load time over 1.5 s — the intended signal that
the deployment's cache is cold, not a bug in the app.

**The browser checks wait for `data-hydrated="true"`.** The app renders its controls disabled
and sets that attribute on `<html>` from a client effect once React has attached the
handlers, so a tap on a slow connection cannot become a native form submit (I5 is the check
for that). Every check that clicks or types calls `waitForHydrated(page)` first; a page that
never reports readiness fails with `the page never reported data-hydrated="true" on <html>`.

The runner also cross-checks what was recorded against a manifest of every check id: a check
that reports nothing, an id outside the manifest, a duplicate id, or a SKIP carrying an
unexpected reason is turned into a FAIL, so nothing can pass by staying silent.

Cost is capped by counters that abort the expensive work: 45 Gemini calls and 70 Qloo
requests per run. Without a usable Chromium every browser check is `SKIP: no browser` and
the API-level checks still run; the suite uses the same browser `pnpm verify:ui` uses and
never downloads one.

## Deployment (Railway)

Two services: **this repository as one web service**, and the **native Railway Postgres**
(which provides `DATABASE_URL` for the web service).

The Railway dashboard fields are the authoritative settings; `railway.json` only mirrors
them, so a change made in the repository still has to be applied in the dashboard (or the
other way round). In the deployment this was measured on, the **pre-deploy field was blank
until it was set by hand** to `pnpm db:deploy`; the migrations then ran before the new
release started. The four values to keep in step:

| Dashboard field | Value |
| --- | --- |
| Build | `pnpm build` |
| Pre-deploy | `pnpm db:deploy` |
| Start | `pnpm start` |
| Healthcheck | `/api/health` (timeout 120 s) |

The build needs no database, no Qloo key and no Gemini key; `pnpm start` binds `$PORT` on
0.0.0.0; `pnpm db:deploy` is `prisma migrate deploy`, which needs `DATABASE_URL` only and is
idempotent; `/api/health` answers `200 {ok,db}`.

On failure the service restarts, up to 10 times. The build needs no secret: `prisma generate`
runs in install/build and never opens a connection, so a first deploy can succeed before the
variables are filled in — but the app stops at boot, loudly and by name only, if
`DATABASE_URL` is absent or `SESSION_SECRET` is missing or shorter than 32 characters.
`pre-deploy` is what applies the migrations, so it has to actually run before the release
starts: if the field is empty in the dashboard, the app boots against an unmigrated
database.

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
| `TRUSTED_PROXY_HOPS` | no | 1 | Proxies appending to `X-Forwarded-For`. Measured as 2 in the Railway deployment this was built against; verify it per deployment (see below). |
| `LIVE_GENERATIONS_PER_DAY` | no | 250 | Soft daily cap on uncached builds. |
| `LLM_CALLS_PER_HOUR` | no | 120 | Above this, narration falls back to the template. Visitor traffic only: `pnpm warm` is an operator run and is not capped by it. |
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

### How to verify `TRUSTED_PROXY_HOPS`

The code default is 1 (`src/lib/config.ts`): one proxy appending one entry, the usual
shape. **In the Railway deployment this was measured as 2.** `X-Forwarded-For` arrives
there with two entries — the client first, Railway's own proxy second — and `X-Real-IP`
equals the first entry, so `TRUSTED_PROXY_HOPS=2` is the value that points at the
visitor. That is an observation from one deployment, not a promise about Railway: verify
it again on any other one.

Set `LOG_IP_PROBE=1` for a short window (it logs only the first five requests per process,
never an address) and hit the site from two different networks. Compare the `ip_probe`
lines: each `tags=[…]` entry is a one-way fingerprint of one `X-Forwarded-For` hop, and
`derived_idx` is the entry `TRUSTED_PROXY_HOPS` currently selects.

- The tag that **changes** between the two visits is the visitor; the tags that stay the
  same are proxies.
- `derived_idx` must point at the changing tag, and `derived_private` must be `false`.
  A `derived_private=true` from a real visitor means every visitor is sharing one bucket,
  which is the failure this check exists to catch.
- `xri` is the same fingerprint of `X-Real-IP`, so when the two agree they are the same
  address.

Turn the probe off (`LOG_IP_PROBE` unset or `0`) as soon as the check is done.

### One instance

Rate limits, the daily generation cap and the LLM hourly cap are in-memory, so the service
must run a **single replica**. Two replicas would double every allowance and let a caller
half their own rate limit by reconnecting.

### Warm the presets before sharing the URL

A fresh database serves no preset from cache, so the first visitor's click would spend Qloo
and Gemini and take 8–20 s. Warm the six preset rows first, from a machine that can reach
the deployment's database. The connection string is typed at a hidden prompt, never as an
argument:

```bash
pnpm warm:remote --check        # read the six stored rows; spends nothing
pnpm warm:remote --until-ok     # rebuild the rows that are not llm yet
pnpm warm:remote --only roots-gt-la:es
```

`pnpm warm:remote` refuses when stdin is not a TTY (there would be no way to hide the
value), when the string is empty, not a Postgres URL, or points at localhost — for a local
database `pnpm warm` is the command you want. It prints the word `remote`, requires a typed
`yes`, and then runs `warm` with the string **only in the child process environment**: it is
never written to a file, echoed, logged, put in the shell history or left in the parent's
environment. The `--check`, `--until-ok`, `--only`, `--max-rounds` and `--pause-s` flags are
forwarded, and `--confirm-remote` is implied.

**The Postgres TCP proxy has to be enabled while it runs, and removed afterwards.** The
warm reaches the deployment's database directly; the app in between does not need it. After
the warm, delete the proxy (and `LOG_IP_PROBE`, if it was on).

`pnpm warm` itself refuses any non-local database unless `--confirm-remote` is passed,
prints only `local` or `remote` (never the host), and asks again on every run — so warming
production by accident is not possible. `--check` reads the six stored rows without spending
anything and exits non-zero if any is missing for the current `PIPELINE_VERSION` or still on
template narration; a stale-but-present row is a warning, not a failure.

Then verify the deployment itself:

```bash
E2E_BASE_URL=https://<host> pnpm e2e -- --profile prod
```

### Before judging

- `pnpm warm:remote --check` exits 0 — all six rows `llm`, none on template narration. A
  `fail:missing` row means the deployment's cache is cold; a `fail:template` row means the
  narration is still the fallback.
- Gemini's free tier is capped **per day and per model**, so a chain with two fallbacks is
  really one model once its own daily quota is spent. Billing enabled on the Google project
  removes that daily ceiling; without it, re-run the warm after the reset (the early stop
  above prints the time).
- Re-warm after any change that bumps `PIPELINE_VERSION` (the signature includes it, so
  every stored row becomes a miss), and once more after the feature freeze.
- `LOG_IP_PROBE` is off.
- The Postgres TCP proxy is removed.

## Judge quick path

1. Open https://dropq.focampo.com (or the Devpost demo link) and click **Roots GT → LA** — the pack should load from cache.
2. Toggle **EN/ES**, turn **Deep cuts** on/off, open **Why Qloo**, then **Compare with an LLM-only answer**.
3. Click **Open brief**, switch language on the brief page, then **Print / Save as PDF**.

## Limitations

- Free-tier Qloo and Gemini quotas; the app refuses custom live packs when the monthly reserve or daily soft cap is hit (presets and cached packs keep working).
- Rate limits and soft caps are **in memory** for one instance.
- The `do` slot's lodging filter reads only the first eight tags of a place, because its keywords are substrings ("Innovation" and "Dinner" both contain "inn"). The pipeline's own count and the final check share that window.
- No Content-Security-Policy yet (Next inline scripts need nonces).
- Cultural coverage and place imagery vary by city; unverified items are labeled; affinities are group-level, not personal predictions.

## License

MIT. See `LICENSE`. The app footer shows the MIT license (EN/ES); set `NEXT_PUBLIC_REPOSITORY_URL` for a source link.

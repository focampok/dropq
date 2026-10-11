# DropQ

Nights packed from taste, not guesses — powered by Qloo.

DropQ packs a night for an audience and a city the way a promoter would. The organizer names a few public cultural anchors, a destination, and an event kind. Plan A (Roots) stays close to those anchors. Plan B (Bridge) reaches toward the city. Every card cites a Qloo entity. The LLM only orchestrates and narrates; taste comes from Qloo.

## Requirements

- Node `>= 22.19`
- pnpm
- A Postgres database

## Setup

```bash
cp .env.example .env
```

Set `DATABASE_URL` and `SESSION_SECRET` in `.env`. For development, point `DATABASE_URL` at a local Postgres database or a Railway development database.

```bash
pnpm install
pnpm prisma migrate dev
pnpm prisma generate
pnpm dev
```

Tests:

```bash
pnpm test
```

## MOCK mode

An empty `QLOO_API_KEY` uses MOCK fixtures. The UI still loads. MOCK ids are not real graph ids, and MOCK cards are labeled.

## When the key arrives

Put the key in `QLOO_API_KEY` on the server only. Never use a `NEXT_PUBLIC_` variable for it. The base URL stays `https://hackathon.api.qloo.com` unless the smoke report says otherwise. The header is `X-Api-Key`.

```bash
pnpm smoke
```

That writes `docs/gates.md` and redacted samples under `docs/gates/`. With an empty key it prints `skipped_no_key` and exits 0.

Round-2 probes (Bridge quality, location, explainability, place strategies, anchor disambiguation):

```bash
pnpm probe:round2
```

That writes `docs/gates-round2.md` and `docs/gates-round2-share.md`. The derived settings live in `src/lib/pipeline/config.ts`: `PLACE_STRATEGY`, `PLACE_TIMEOUT_MS`, `PLACE_RADIUS_FALLBACK_M`, `BRIDGE_VARIANT`, and the pinned preset entity ids.

The place slot never sends `filter.exclude.entities`. It asks for 20 hits and drops the Roots ids client-side instead; when that leaves nothing usable it retries once at `PLACE_RADIUS_FALLBACK_M` (40 000 m) before the slot is omitted, and only then does the coverage note carry the stage counts and the retry.

Bridge anchors are ranked by how many distinct tags they share with the seed anchors. When two or more Roots candidates share at least one tag, only those are used (up to three, one per slot); otherwise the top hit per slot wins in the order listen, wear, watch.

The place slot tries `PLACE_CATEGORY_TAGS` first and falls back to `PLACE_CATEGORY_TAGS_FALLBACK` only when the first set leaves the slot empty, which is the case for New York in a `con` context: hop 1 sends the same city request as hop 0, so the live-music list comes back identical and every hit is already a Roots id.

## The LLM

Pick a provider with `LLM_PROVIDER`. Model ids and the API key are configuration: they belong in `.env`, never in source or git.

| `LLM_PROVIDER` | Provider | Variables it needs |
| --- | --- | --- |
| `nebius` | Nebius (OpenAI-compatible) | `NEBIUS_API_KEY`, `NEBIUS_BASE_URL`, `NEBIUS_MODEL` |
| `google` | Google Generative AI | a key and a principal model, below |
| empty | off, unless the three Nebius variables are set, which means `nebius` | — |

Google reads `GOOGLE_GENERATIVE_AI_API_KEY`, or `GEMINI_API_KEY` when the first is empty. The chain principal is `GEMINI_MODEL`, or `LLM_MODEL` when `GEMINI_MODEL` is empty, then `GEMINI_FALLBACK_MODELS` (comma-separated, trimmed, empties and the principal dropped). There is no default model id. A model that appears in a model list can still return 404 on `generateContent`; `gemini-2.5-flash` does that for some keys, so it is not a default. No key sets `coverage.llm.off` to `no_key`. No principal sets it to `no_model`. The process still boots.

`GEMINI_RETRY_ATTEMPTS` (default 3), `GEMINI_RETRY_DELAY_MS` (default 1000) and `GEMINI_RETRY_MAX_DELAY_MS` (default 8000) use `Number(env) || default`, so `0`, empty and `NaN` fall back to those defaults. Attempts are then at least 1. The budget for one call is attempts × models. A permanent error (400, 401, 403, 404, 422, an invalid prompt, an unknown model) discards that model and continues with no sleep. A transient error (429, 500, 502, 503, 504, no HTTP status, or a network, timeout, abort or socket failure) sleeps `min(delay × 2^min(n-1, 5), cap)` and rotates to the next model that is still in play. The model that just succeeded is tried first on the next call. `generateObject` is called with `maxRetries: 0`, so this loop is the only retry. When the budget or the models run out, the last error is thrown and the caller uses rule B or the template. `coverage.llm.failures` records `rate_limited`, `model_unavailable`, `auth`, `server_error`, `network` or `deadline` from that error.

One difference from a plain retry loop: the anchor call sits before first paint, so the existing wall-clock deadlines (anchors 6 s, narration 12 s) wrap the whole loop. A sleep that would end after the deadline is not started, and a hung attempt is aborted. Validation and JSON failures stay on the same model for one repair retry and do not discard it.

Gemini calls set `providerOptions.google.thinkingConfig.thinkingLevel` to `minimal` (the lowest level the installed `@ai-sdk/google` provider allows). If a model rejects that option, the next attempt for that model omits it.

What the LLM does:

- Picks the Bridge anchors from a closed list of candidates that rule B already ranked. It can re-rank them; it can never introduce one. An id outside the list, two ids from one slot, or a transport failure falls back to rule B and sets `coverage.llm.anchorSource` to `rule_b_fallback`.
- Writes the connecting sentence and headline for each plan. It never types an item name: it writes tokens (`[[watch]]`, `[[listen]]`, `[[wear]]`, `[[do]]`, `[[anchor1]]`, `[[city]]`) and the server substitutes the pack's own names after validating them. A token that is not allowed, a repeated token, a URL, an over-long line or a narrative that names nothing is rejected, then one repair retry runs, then the template stays.

What it never does: create, add, replace, or rank items. Every card comes from Qloo.

Every call uses `generateObject` with a Zod schema and a low temperature. The pack is stored with the template narrative first, so first paint never waits for narration, and a `narrate` step then swaps in the LLM text when it arrives. The UI shows the small AI badge only on a narrative whose own `source` is `llm`. `coverage.llm` also records `modelUsed`, `attempts`, `chainTried` and `latencyMs`.

`pnpm probe:llm` calls each model in the chain once with the real narration schema, on the saved Latin tour fixture, and prints latency only.

## Local verification

```bash
pnpm build
pnpm start &          # or pnpm dev
pnpm verify:local     # BASE_URL, default http://localhost:3000
pnpm verify:images    # HEAD requests to the image hosts, no bodies
pnpm verify:ui        # Chromium at 1280 px and 390 px, screenshots to docs/screenshots
```

`verify:local` runs the pack stream for each preset, sequentially, and asserts the invariants, the session gate, the Deep cuts round trip, the narration fallback rate, the copy checks and the Qloo quota, then exits non-zero if anything fails. `--llm-budget <n>` (default 80) stops the script when the reported Gemini calls would pass that budget. `verify:ui` needs a Chromium in the Playwright cache and never downloads one.

## Rate limit and quota

Qloo allows 5 requests per second and 10 000 per month. The client queues calls at 4 per second and honors `Retry-After` on HTTP 429. Each response's `x-month-ratelimit-remaining` is kept in memory. Below 800, live calls stop and routes return `QUOTA_LOW` (HTTP 503) unless the answer is already cached. Search results are cached for 14 days. Insight responses are cached for 72 hours. Cache hits do not count against the limiter or the quota.

`POST /api/session/:id/pack` streams NDJSON (`application/x-ndjson`), one JSON object per step, and ends with `{ "step": "done", "packIds": [...] }`. Other routes are limited to 60 requests per minute per IP. Pack generation is limited to 4 per minute and 20 per hour.

Warm the three presets into the cache:

```bash
pnpm warm
```

It prints only counts and timings, and stops if the quota guard is active.

The optional `@qloo/qloo-harness` CLI is for learning tags. DropQ does not import it.

## SAFE_USE

Do not send personal data to Qloo. Anchors are public cultural concepts. Results are group affinities, not a prediction about one person. The app does not infer ethnicity, nationality, or immigration status.

Demo presets: Roots GT → LA is Ricardo Arjona · Pollo Campero · Gaby Moreno. Latin tour → Houston is Bad Bunny · Karol G · Nike. Anime con → NYC is Jujutsu Kaisen · YOASOBI · Crunchyroll.

## Deploying to Railway

Use one web service that runs Next as a continuous Node process. Add the Postgres plugin.

Set these variables by name: `DATABASE_URL`, `SESSION_SECRET`, `QLOO_API_KEY`, `QLOO_BASE_URL`, `LLM_PROVIDER`, `LLM_MODEL`, `NEBIUS_API_KEY`, `NEBIUS_BASE_URL`, `NEBIUS_MODEL`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`, `GEMINI_RETRY_ATTEMPTS`, `GEMINI_RETRY_DELAY_MS`, `GEMINI_RETRY_MAX_DELAY_MS`.

- Build command: `pnpm build`
- Release / pre-deploy command: `pnpm db:deploy`
- Start command: `pnpm start`
- Health check path: `/api/health`

After the first deploy, run `pnpm warm` once against production. Before publishing, set the repository license to MIT in GitHub About.

This repo does not ship a Railway config file, Dockerfile, or Procfile.

## Next build steps

- LLM-only baseline
- Brief export
- Public Railway deploy

## License

MIT. When the GitHub repository is published, set the About license to MIT.

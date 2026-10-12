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
| Tags | Shared-tag evidence for Bridge anchors. |
| Insights + explainability | Fill slots; explainability is stored when present. |
| Analysis | Supporting signals where the pipeline uses them. |

Bridge anchors are chosen from a **closed list** ranked by shared tags (rule B); the LLM may only re-order that list. Measured limits we work within: about **5 requests/second**, **10 000 requests/month**, no reliable per-item affinity score, and many places without images.

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

Optional: `pnpm warm` prebuilds the three presets in English and Spanish into the pack cache (needs Qloo + LLM). `pnpm verify:local` exercises presets over HTTP against a running app.

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
| `LIVE_GENERATIONS_PER_DAY` | Soft daily live-generation cap |
| `LLM_CALLS_PER_HOUR` | Soft hourly Gemini cap |
| `PACK_CACHE_TTL_HOURS` | Pack cache TTL (presets use 72h) |

## Limitations

- Free-tier Qloo and Gemini quotas; the app refuses custom live packs when the monthly reserve or daily soft cap is hit (presets and cached packs keep working).
- Rate limits and soft caps are **in memory** for one instance.
- Fandom wear brands can be noisy in insights.
- No Content-Security-Policy yet (Next inline scripts need nonces).

## License

MIT. See `LICENSE`.

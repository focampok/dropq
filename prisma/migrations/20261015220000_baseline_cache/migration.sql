-- Reshape baseline_run from session-scoped rows into a language-neutral cache keyed
-- by cards signature + locale (same identity as packCardsSignature). Safe on empty
-- and on the current production schema: the old table held no visitor-facing cache.

DROP TABLE IF EXISTS "baseline_run";

CREATE TABLE "baseline_run" (
    "signature" TEXT NOT NULL,
    "cards_sig" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "llm_items" JSONB NOT NULL,
    "verification" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "built_at" TIMESTAMP(3) NOT NULL,
    "is_preset" BOOLEAN NOT NULL DEFAULT false,
    "qloo_calls" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "baseline_run_pkey" PRIMARY KEY ("signature")
);

CREATE INDEX "baseline_run_built_at_idx" ON "baseline_run"("built_at");
CREATE INDEX "baseline_run_cards_sig_locale_idx" ON "baseline_run"("cards_sig", "locale");

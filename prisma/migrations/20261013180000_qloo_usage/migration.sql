-- Our own monthly Qloo request counter: one row per UTC calendar month key.
-- IF NOT EXISTS keeps this safe to re-apply and safe on an empty database.
CREATE TABLE IF NOT EXISTS "qloo_usage" (
    "month" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qloo_usage_pkey" PRIMARY KEY ("month")
);

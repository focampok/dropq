-- CreateTable
CREATE TABLE "pack_cache" (
    "signature" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "built_at" TIMESTAMP(3) NOT NULL,
    "qloo_calls" INTEGER NOT NULL DEFAULT 0,
    "is_preset" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pack_cache_pkey" PRIMARY KEY ("signature")
);

-- CreateIndex
CREATE INDEX "pack_cache_built_at_idx" ON "pack_cache"("built_at");

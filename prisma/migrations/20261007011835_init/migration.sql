-- CreateEnum
CREATE TYPE "event_kind" AS ENUM ('tour', 'con', 'comunidad');

-- CreateEnum
CREATE TYPE "seed_source" AS ENUM ('text', 'preset', 'stt');

-- CreateEnum
CREATE TYPE "seed_domain" AS ENUM ('artist', 'movie', 'tv_show', 'brand', 'place', 'tag', 'unknown');

-- CreateEnum
CREATE TYPE "pack_label" AS ENUM ('A', 'B');

-- CreateEnum
CREATE TYPE "pack_axis" AS ENUM ('root', 'bridge');

-- CreateEnum
CREATE TYPE "pack_status" AS ENUM ('draft', 'ready', 'stale');

-- CreateEnum
CREATE TYPE "slot" AS ENUM ('watch', 'listen', 'wear', 'do');

-- CreateEnum
CREATE TYPE "confidence" AS ENUM ('high', 'medium', 'low', 'unverified');

-- CreateEnum
CREATE TYPE "provenance" AS ENUM ('qloo', 'mock');

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "city" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "event_kind" "event_kind",
    "time_window" TEXT,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seed" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "raw_text" TEXT NOT NULL,
    "source" "seed_source" NOT NULL,
    "resolved_entity_id" TEXT,
    "resolved_name" TEXT,
    "domain" "seed_domain" NOT NULL DEFAULT 'unknown',
    "qloo_raw" JSONB,

    CONSTRAINT "seed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qloo_entity_cache" (
    "entity_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qloo_entity_cache_pkey" PRIMARY KEY ("entity_id")
);

-- CreateTable
CREATE TABLE "insight_cache" (
    "cache_key" TEXT NOT NULL,
    "filter_type" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insight_cache_pkey" PRIMARY KEY ("cache_key")
);

-- CreateTable
CREATE TABLE "pack" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "label" "pack_label" NOT NULL,
    "axis" "pack_axis" NOT NULL,
    "status" "pack_status" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "narrative" TEXT,
    "coverage" JSONB,

    CONSTRAINT "pack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pack_item" (
    "id" TEXT NOT NULL,
    "pack_id" TEXT NOT NULL,
    "slot" "slot" NOT NULL,
    "position" INTEGER NOT NULL,
    "hop" INTEGER NOT NULL,
    "qloo_entity_id" TEXT NOT NULL,
    "qloo_name" TEXT NOT NULL,
    "qloo_type" TEXT NOT NULL,
    "image_url" TEXT,
    "affinity_score" DOUBLE PRECISION,
    "explain" TEXT,
    "evidence" JSONB,
    "enrich" JSONB,
    "maps_url" TEXT,
    "external_url" TEXT,
    "confidence" "confidence" NOT NULL,
    "provenance" "provenance" NOT NULL,

    CONSTRAINT "pack_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "baseline_run" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "llm_items" JSONB NOT NULL,
    "verification" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "baseline_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "session_last_active_at_idx" ON "session"("last_active_at");

-- CreateIndex
CREATE INDEX "seed_session_id_idx" ON "seed"("session_id");

-- CreateIndex
CREATE INDEX "insight_cache_fetched_at_idx" ON "insight_cache"("fetched_at");

-- CreateIndex
CREATE INDEX "baseline_run_session_id_idx" ON "baseline_run"("session_id");

-- AddForeignKey
ALTER TABLE "seed" ADD CONSTRAINT "seed_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pack" ADD CONSTRAINT "pack_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pack_item" ADD CONSTRAINT "pack_item_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "pack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "baseline_run" ADD CONSTRAINT "baseline_run_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

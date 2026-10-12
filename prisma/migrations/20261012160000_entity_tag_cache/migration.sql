-- The tags of an entity, looked up by id (see model EntityTagCache).
CREATE TABLE "entity_tag_cache" (
    "entity_id" TEXT NOT NULL,
    "tags" JSONB NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entity_tag_cache_pkey" PRIMARY KEY ("entity_id")
);

CREATE INDEX "entity_tag_cache_fetched_at_idx" ON "entity_tag_cache"("fetched_at");

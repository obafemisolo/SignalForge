CREATE TYPE "SourceFetchMode" AS ENUM ('HTTP', 'PLAYWRIGHT');

ALTER TABLE "source_documents"
ADD COLUMN "canonicalUrl" VARCHAR(2048),
ADD COLUMN "metadata" JSONB,
ADD COLUMN "outboundLinks" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "fetchMode" "SourceFetchMode",
ADD COLUMN "fetchDurationMs" INTEGER;

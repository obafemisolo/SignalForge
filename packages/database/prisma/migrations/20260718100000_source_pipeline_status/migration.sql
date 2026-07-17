CREATE TYPE "SourceProcessingStatus" AS ENUM (
  'PENDING',
  'FETCHING',
  'EXTRACTING',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED'
);

ALTER TABLE "source_documents"
ADD COLUMN "processingStatus" "SourceProcessingStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "processingAttempt" INTEGER NOT NULL DEFAULT 0;

UPDATE "source_documents"
SET "processingStatus" = CASE
  WHEN "fetchStatus" = 'SUCCEEDED' THEN 'SUCCEEDED'::"SourceProcessingStatus"
  WHEN "fetchStatus" IN ('FAILED', 'BLOCKED', 'SKIPPED') THEN 'FAILED'::"SourceProcessingStatus"
  WHEN "fetchStatus" = 'FETCHING' THEN 'FETCHING'::"SourceProcessingStatus"
  ELSE 'PENDING'::"SourceProcessingStatus"
END;

CREATE INDEX "source_documents_researchJobId_processingStatus_idx"
ON "source_documents"("researchJobId", "processingStatus");

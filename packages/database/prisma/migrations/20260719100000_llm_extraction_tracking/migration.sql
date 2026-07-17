ALTER TABLE "source_documents"
ADD COLUMN "llmProvider" VARCHAR(100),
ADD COLUMN "llmModel" VARCHAR(200),
ADD COLUMN "llmUsage" JSONB,
ADD COLUMN "llmMetadata" JSONB,
ADD COLUMN "llmProcessedAt" TIMESTAMPTZ(3);

DELETE FROM "extracted_records"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT
      "id",
      ROW_NUMBER() OVER (
        PARTITION BY "sourceDocumentId", "deduplicationKey"
        ORDER BY "createdAt", "id"
      ) AS "duplicateNumber"
    FROM "extracted_records"
  ) AS "ranked_records"
  WHERE "duplicateNumber" > 1
);

CREATE UNIQUE INDEX "extracted_records_sourceDocumentId_deduplicationKey_key"
ON "extracted_records"("sourceDocumentId", "deduplicationKey");

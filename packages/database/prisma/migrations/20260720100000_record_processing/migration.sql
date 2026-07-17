ALTER TABLE "source_documents"
ADD COLUMN "recordDuplicatesRemoved" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "extracted_records"
ADD COLUMN "normalizedData" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "sourceAttributions" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "scoreExplanation" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "reviewRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "conflictDetails" JSONB;

CREATE INDEX "extracted_records_researchJobId_reviewRequired_relevanceScore_idx"
ON "extracted_records"(
  "researchJobId",
  "reviewRequired",
  "relevanceScore" DESC
);

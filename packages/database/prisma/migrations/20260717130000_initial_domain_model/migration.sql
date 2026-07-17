-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ResearchJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "SourceFetchStatus" AS ENUM ('PENDING', 'FETCHING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'SKIPPED');

-- CreateTable
CREATE TABLE "research_jobs" (
    "id" UUID NOT NULL,
    "query" TEXT NOT NULL,
    "status" "ResearchJobStatus" NOT NULL DEFAULT 'QUEUED',
    "requestedSources" TEXT[] NOT NULL,
    "extractionSchema" JSONB NOT NULL,
    "totalSources" INTEGER NOT NULL DEFAULT 0,
    "successfulSources" INTEGER NOT NULL DEFAULT 0,
    "failedSources" INTEGER NOT NULL DEFAULT 0,
    "duplicatesRemoved" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "research_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_documents" (
    "id" UUID NOT NULL,
    "researchJobId" UUID NOT NULL,
    "sourceUrl" VARCHAR(2048) NOT NULL,
    "normalizedUrl" VARCHAR(2048) NOT NULL,
    "domain" VARCHAR(253) NOT NULL,
    "title" TEXT,
    "rawContent" TEXT,
    "contentHash" CHAR(64),
    "fetchStatus" "SourceFetchStatus" NOT NULL DEFAULT 'PENDING',
    "httpStatus" SMALLINT,
    "fetchedAt" TIMESTAMPTZ(3),
    "errorCode" VARCHAR(100),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "source_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extracted_records" (
    "id" UUID NOT NULL,
    "researchJobId" UUID NOT NULL,
    "sourceDocumentId" UUID NOT NULL,
    "recordType" VARCHAR(100) NOT NULL,
    "structuredData" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "relevanceScore" DOUBLE PRECISION NOT NULL,
    "deduplicationKey" VARCHAR(256) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "extracted_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_events" (
    "id" UUID NOT NULL,
    "researchJobId" UUID NOT NULL,
    "eventType" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "research_jobs_status_createdAt_idx" ON "research_jobs"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "source_documents_researchJobId_fetchStatus_idx" ON "source_documents"("researchJobId", "fetchStatus");

-- CreateIndex
CREATE INDEX "source_documents_domain_fetchedAt_idx" ON "source_documents"("domain", "fetchedAt" DESC);

-- CreateIndex
CREATE INDEX "source_documents_contentHash_idx" ON "source_documents"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "source_documents_id_researchJobId_key" ON "source_documents"("id", "researchJobId");

-- CreateIndex
CREATE UNIQUE INDEX "source_documents_researchJobId_normalizedUrl_key" ON "source_documents"("researchJobId", "normalizedUrl");

-- CreateIndex
CREATE INDEX "extracted_records_researchJobId_deduplicationKey_idx" ON "extracted_records"("researchJobId", "deduplicationKey");

-- CreateIndex
CREATE INDEX "extracted_records_researchJobId_relevanceScore_idx" ON "extracted_records"("researchJobId", "relevanceScore" DESC);

-- CreateIndex
CREATE INDEX "extracted_records_sourceDocumentId_idx" ON "extracted_records"("sourceDocumentId");

-- CreateIndex
CREATE INDEX "job_events_researchJobId_createdAt_idx" ON "job_events"("researchJobId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "job_events_eventType_createdAt_idx" ON "job_events"("eventType", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_researchJobId_fkey" FOREIGN KEY ("researchJobId") REFERENCES "research_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_records" ADD CONSTRAINT "extracted_records_researchJobId_fkey" FOREIGN KEY ("researchJobId") REFERENCES "research_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_records" ADD CONSTRAINT "extracted_records_sourceDocumentId_researchJobId_fkey" FOREIGN KEY ("sourceDocumentId", "researchJobId") REFERENCES "source_documents"("id", "researchJobId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_researchJobId_fkey" FOREIGN KEY ("researchJobId") REFERENCES "research_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Domain invariants that Prisma Schema Language cannot currently express.
ALTER TABLE "research_jobs"
    ADD CONSTRAINT "research_jobs_query_not_blank_check"
        CHECK (length(btrim("query")) > 0),
    ADD CONSTRAINT "research_jobs_extraction_schema_object_check"
        CHECK (jsonb_typeof("extractionSchema") = 'object'),
    ADD CONSTRAINT "research_jobs_source_counts_nonnegative_check"
        CHECK (
            "totalSources" >= 0
            AND "successfulSources" >= 0
            AND "failedSources" >= 0
            AND "duplicatesRemoved" >= 0
        ),
    ADD CONSTRAINT "research_jobs_source_counts_bounded_check"
        CHECK ("successfulSources" + "failedSources" <= "totalSources"),
    ADD CONSTRAINT "research_jobs_requested_sources_count_check"
        CHECK (cardinality("requestedSources") = "totalSources"),
    ADD CONSTRAINT "research_jobs_timestamps_ordered_check"
        CHECK (
            "completedAt" IS NULL
            OR "startedAt" IS NULL
            OR "completedAt" >= "startedAt"
        );

ALTER TABLE "source_documents"
    ADD CONSTRAINT "source_documents_content_hash_check"
        CHECK (
            "contentHash" IS NULL
            OR "contentHash" ~ '^[a-f0-9]{64}$'
        ),
    ADD CONSTRAINT "source_documents_http_status_check"
        CHECK (
            "httpStatus" IS NULL
            OR "httpStatus" BETWEEN 100 AND 599
        );

ALTER TABLE "extracted_records"
    ADD CONSTRAINT "extracted_records_structured_data_object_check"
        CHECK (jsonb_typeof("structuredData") = 'object'),
    ADD CONSTRAINT "extracted_records_evidence_array_check"
        CHECK (
            jsonb_typeof("evidence") = 'array'
            AND jsonb_array_length("evidence") > 0
        ),
    ADD CONSTRAINT "extracted_records_confidence_score_check"
        CHECK ("confidenceScore" BETWEEN 0.0 AND 1.0),
    ADD CONSTRAINT "extracted_records_relevance_score_check"
        CHECK ("relevanceScore" BETWEEN 0.0 AND 1.0);

ALTER TABLE "job_events"
    ADD CONSTRAINT "job_events_payload_object_check"
        CHECK (jsonb_typeof("payload") = 'object');

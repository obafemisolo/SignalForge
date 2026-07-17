ALTER TABLE "research_jobs"
ADD COLUMN "idempotencyKeyHash" CHAR(64),
ADD COLUMN "requestFingerprint" CHAR(64);

CREATE UNIQUE INDEX "research_jobs_idempotencyKeyHash_key"
ON "research_jobs"("idempotencyKeyHash");

ALTER TABLE "research_jobs"
ADD CONSTRAINT "research_jobs_idempotency_pair_check"
CHECK (
  ("idempotencyKeyHash" IS NULL AND "requestFingerprint" IS NULL)
  OR
  ("idempotencyKeyHash" IS NOT NULL AND "requestFingerprint" IS NOT NULL)
);

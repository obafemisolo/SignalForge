import { createHash } from "node:crypto";

import {
  createDatabaseClient,
  createRepositories,
  disconnectDatabase,
  PersistenceConflictError,
  PersistenceValidationError,
  type PrismaClient,
  type Repositories,
} from "@signalforge/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe.sequential;

const extractionSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    name: { type: "string" },
    summary: { type: "string" },
  },
  required: ["name", "summary"],
  additionalProperties: false,
};

describeWithDatabase("database repositories", () => {
  let prisma: PrismaClient;
  let repositories: Repositories;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error("TEST_DATABASE_URL must be defined");
    }

    prisma = createDatabaseClient({
      databaseUrl: testDatabaseUrl,
      connectionTimeoutMs: 5_000,
      maxConnections: 4,
    });
    await prisma.$connect();
    repositories = createRepositories(prisma);
  });

  beforeEach(async () => {
    await prisma.researchJob.deleteMany();
  });

  afterAll(async () => {
    await disconnectDatabase(prisma);
  });

  it("creates jobs and idempotently reuses a normalized source", async () => {
    const researchJob = await repositories.researchJobs.create({
      query: "Research SignalForge",
      requestedSources: ["https://example.com/research"],
      extractionSchema,
    });

    const sourceInput = {
      researchJobId: researchJob.id,
      sourceUrl: "https://example.com/research?utm_source=test",
      normalizedUrl: "https://example.com/research",
      domain: "example.com",
    };
    const firstSource =
      await repositories.sourceDocuments.createOrGet(sourceInput);
    const duplicateSource =
      await repositories.sourceDocuments.createOrGet(sourceInput);

    expect(duplicateSource.id).toBe(firstSource.id);
    await expect(prisma.sourceDocument.count()).resolves.toBe(1);
    expect(researchJob.totalSources).toBe(1);
  });

  it("persists only schema-valid records with source-backed evidence", async () => {
    const researchJob = await repositories.researchJobs.create({
      query: "Research SignalForge",
      requestedSources: ["https://example.com/research"],
      extractionSchema,
    });
    const source = await repositories.sourceDocuments.createOrGet({
      researchJobId: researchJob.id,
      sourceUrl: "https://example.com/research",
      normalizedUrl: "https://example.com/research",
      domain: "example.com",
    });
    const rawContent =
      "SignalForge is a public web-research pipeline with source evidence.";

    await repositories.sourceDocuments.markSucceeded(source.id, {
      title: "SignalForge",
      rawContent,
      contentHash: createHash("sha256").update(rawContent).digest("hex"),
      httpStatus: 200,
      fetchedAt: new Date(),
    });

    const baseRecord = {
      researchJobId: researchJob.id,
      sourceDocumentId: source.id,
      recordType: "project",
      evidence: [{ quote: "public web-research pipeline" }],
      confidenceScore: 0.9,
      relevanceScore: 0.95,
      deduplicationKey: "project:signalforge",
    };

    await expect(
      repositories.extractedRecords.createValidated({
        ...baseRecord,
        structuredData: {
          name: 42,
          summary: "Invalid because name is not a string",
        },
      }),
    ).rejects.toBeInstanceOf(PersistenceValidationError);
    await expect(prisma.extractedRecord.count()).resolves.toBe(0);

    const record = await repositories.extractedRecords.createValidated({
      ...baseRecord,
      structuredData: {
        name: "SignalForge",
        summary: "A public web-research pipeline.",
      },
    });

    expect(record.deduplicationKey).toBe("project:signalforge");
    await expect(prisma.extractedRecord.count()).resolves.toBe(1);

    await expect(
      repositories.extractedRecords.createValidated({
        ...baseRecord,
        deduplicationKey: "project:unsupported",
        structuredData: {
          name: "Unsupported",
          summary: "The evidence is fabricated.",
        },
        evidence: [{ quote: "This quote does not occur in the source." }],
      }),
    ).rejects.toBeInstanceOf(PersistenceValidationError);
    await expect(prisma.extractedRecord.count()).resolves.toBe(1);
  });

  it("rejects a source document owned by another research job", async () => {
    const firstJob = await repositories.researchJobs.create({
      query: "First job",
      requestedSources: ["https://example.com/first"],
      extractionSchema,
    });
    const secondJob = await repositories.researchJobs.create({
      query: "Second job",
      requestedSources: ["https://example.com/second"],
      extractionSchema,
    });
    const source = await repositories.sourceDocuments.createOrGet({
      researchJobId: firstJob.id,
      sourceUrl: "https://example.com/first",
      normalizedUrl: "https://example.com/first",
      domain: "example.com",
    });

    await repositories.sourceDocuments.markSucceeded(source.id, {
      rawContent: "Evidence for the first job.",
      contentHash: createHash("sha256")
        .update("Evidence for the first job.")
        .digest("hex"),
      httpStatus: 200,
    });

    await expect(
      repositories.extractedRecords.createValidated({
        researchJobId: secondJob.id,
        sourceDocumentId: source.id,
        recordType: "project",
        structuredData: {
          name: "SignalForge",
          summary: "Cross-job record",
        },
        evidence: [{ quote: "Evidence for the first job." }],
        confidenceScore: 0.8,
        relevanceScore: 0.8,
        deduplicationKey: "cross-job",
      }),
    ).rejects.toBeInstanceOf(PersistenceConflictError);
  });

  it("appends job events and updates bounded progress", async () => {
    const researchJob = await repositories.researchJobs.create({
      query: "Track this job",
      requestedSources: ["https://example.com/track"],
      extractionSchema,
    });

    await repositories.jobEvents.append({
      researchJobId: researchJob.id,
      eventType: "job.started",
      payload: { worker: "integration-test" },
    });

    await expect(
      repositories.researchJobs.updateProgress(researchJob.id, {
        status: "RUNNING",
        successfulSources: 2,
        failedSources: 0,
        duplicatesRemoved: 0,
      }),
    ).rejects.toBeInstanceOf(PersistenceValidationError);

    await repositories.researchJobs.updateProgress(researchJob.id, {
      status: "COMPLETED",
      successfulSources: 1,
      failedSources: 0,
      duplicatesRemoved: 0,
      startedAt: new Date("2026-07-17T10:00:00.000Z"),
      completedAt: new Date("2026-07-17T10:01:00.000Z"),
    });

    const events = await repositories.jobEvents.listForJob(researchJob.id);
    const updatedJob = await repositories.researchJobs.findById(researchJob.id);

    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("job.started");
    expect(updatedJob?.status).toBe("COMPLETED");
    expect(updatedJob?.successfulSources).toBe(1);
  });
});

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

  it("creates an idempotent job with source placeholders and retries only failures", async () => {
    const jobInput = {
      query: "Find retryable signals",
      requestedSources: ["https://example.com/retry"],
      extractionSchema,
    };
    const sources = [
      {
        sourceUrl: "https://example.com/retry",
        normalizedUrl: "https://example.com/retry",
        domain: "example.com",
      },
    ];
    const idempotency = {
      idempotencyKeyHash: createHash("sha256")
        .update("integration-key")
        .digest("hex"),
      requestFingerprint: createHash("sha256")
        .update("integration-request")
        .digest("hex"),
    };

    const first = await repositories.researchJobs.createWithSources(
      jobInput,
      sources,
      idempotency,
    );
    const repeated = await repositories.researchJobs.createWithSources(
      jobInput,
      sources,
      idempotency,
    );

    expect(first.reused).toBe(false);
    expect(repeated.reused).toBe(true);
    expect(repeated.job.id).toBe(first.job.id);
    await expect(prisma.sourceDocument.count()).resolves.toBe(1);

    const source = await prisma.sourceDocument.findFirstOrThrow({
      where: { researchJobId: first.job.id },
    });
    await repositories.sourceDocuments.markFailed(source.id, {
      fetchStatus: "FAILED",
      errorCode: "TIMEOUT",
      errorMessage: "The source timed out",
    });

    await expect(
      repositories.researchJobs.prepareFailedSourcesForRetry(first.job.id),
    ).resolves.toEqual([source.id]);
    await expect(
      repositories.researchJobs.prepareFailedSourcesForRetry(first.job.id),
    ).rejects.toBeInstanceOf(PersistenceConflictError);

    await expect(
      repositories.researchJobs.createWithSources(jobInput, sources, {
        ...idempotency,
        requestFingerprint: createHash("sha256")
          .update("different-request")
          .digest("hex"),
      }),
    ).rejects.toBeInstanceOf(PersistenceConflictError);
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
      sourceAttributions: [
        {
          sourceDocumentId: source.id,
          sourceUrl: "https://example.com/research",
          evidence: ["public web-research pipeline"],
          publishedAt: null,
          credibilityScore: null,
        },
      ],
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
        sourceAttributions: [
          {
            sourceDocumentId: source.id,
            sourceUrl: "https://example.com/first",
            evidence: ["Evidence for the first job."],
            publishedAt: null,
            credibilityScore: null,
          },
        ],
        confidenceScore: 0.8,
        relevanceScore: 0.8,
        deduplicationKey: "cross-job",
      }),
    ).rejects.toBeInstanceOf(PersistenceConflictError);
  });

  it("atomically replaces a source generation and stores LLM usage metadata", async () => {
    const created = await repositories.researchJobs.createWithSources(
      {
        query: "Research SignalForge",
        requestedSources: ["https://example.com/research"],
        extractionSchema,
      },
      [
        {
          sourceUrl: "https://example.com/research",
          normalizedUrl: "https://example.com/research",
          domain: "example.com",
        },
      ],
    );
    const orchestration = await repositories.pipeline.startOrchestration(
      created.job.id,
    );
    const source = orchestration.sources[0];
    if (source === undefined) {
      throw new Error("Expected an orchestration source");
    }
    const rawContent = "SignalForge is a public web-research pipeline.";
    await repositories.pipeline.markFetchStarted(
      source.id,
      source.processingAttempt,
    );
    await repositories.pipeline.markFetchSucceeded(
      source.id,
      source.processingAttempt,
      {
        rawContent,
        contentHash: createHash("sha256").update(rawContent).digest("hex"),
        httpStatus: 200,
      },
    );
    await repositories.pipeline.markExtractionSucceeded(
      source.id,
      source.processingAttempt,
    );

    const input = {
      researchJobId: created.job.id,
      sourceDocumentId: source.id,
      recordType: "project",
      structuredData: {
        name: "SignalForge",
        summary: "A public web-research pipeline.",
      },
      evidence: [{ quote: "public web-research pipeline" }],
      sourceAttributions: [
        {
          sourceDocumentId: source.id,
          sourceUrl: "https://example.com/research",
          evidence: ["public web-research pipeline"],
          publishedAt: null,
          credibilityScore: null,
        },
      ],
      confidenceScore: 0.9,
      relevanceScore: 0.9,
      deduplicationKey: "project:signalforge",
    };
    await repositories.extractedRecords.replaceValidatedForSource(
      created.job.id,
      source.id,
      source.processingAttempt,
      [input],
      {
        provider: "fake",
        model: "test-model",
        usage: { inputTokens: 100, outputTokens: 20 },
        metadata: { chunkCount: 1, repairedChunks: 0 },
      },
    );
    await repositories.extractedRecords.replaceValidatedForSource(
      created.job.id,
      source.id,
      source.processingAttempt,
      [input],
      {
        provider: "fake",
        model: "test-model",
        usage: { inputTokens: 110, outputTokens: 25 },
        metadata: { chunkCount: 1, repairedChunks: 1 },
      },
    );

    await expect(prisma.extractedRecord.count()).resolves.toBe(1);
    const persistedSource = await prisma.sourceDocument.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(persistedSource).toMatchObject({
      llmProvider: "fake",
      llmModel: "test-model",
      llmUsage: { inputTokens: 110, outputTokens: 25 },
      llmMetadata: { chunkCount: 1, repairedChunks: 1 },
    });
    expect(persistedSource.llmProcessedAt).toBeInstanceOf(Date);
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

  it("serializes terminal progress and completes with partial success", async () => {
    const sources = [
      {
        sourceUrl: "https://example.com/success",
        normalizedUrl: "https://example.com/success",
        domain: "example.com",
      },
      {
        sourceUrl: "https://example.com/failure",
        normalizedUrl: "https://example.com/failure",
        domain: "example.com",
      },
    ];
    const created = await repositories.researchJobs.createWithSources(
      {
        query: "Research two independent sources",
        requestedSources: sources.map((source) => source.sourceUrl),
        extractionSchema,
      },
      sources,
    );
    const orchestration = await repositories.pipeline.startOrchestration(
      created.job.id,
    );
    const [successfulSource, failedSource] = orchestration.sources;

    if (successfulSource === undefined || failedSource === undefined) {
      throw new Error("Expected two orchestration sources");
    }

    for (const source of orchestration.sources) {
      await repositories.pipeline.markFetchStarted(
        source.id,
        source.processingAttempt,
      );
      await repositories.pipeline.markFetchSucceeded(
        source.id,
        source.processingAttempt,
        {
          rawContent: `Evidence from ${source.normalizedUrl}`,
          contentHash: createHash("sha256")
            .update(source.normalizedUrl)
            .digest("hex"),
          httpStatus: 200,
        },
      );
      await repositories.pipeline.markExtractionSucceeded(
        source.id,
        source.processingAttempt,
      );
    }

    await repositories.pipeline.completeSource(
      successfulSource.id,
      successfulSource.processingAttempt,
    );
    await repositories.pipeline.failSource(
      failedSource.id,
      failedSource.processingAttempt,
      {
        queueName: "record-processing",
        jobId: `process-${failedSource.id}-0`,
        errorCode: "RECORD_PROCESSING_FAILED",
        errorMessage: "The final processor rejected this source",
        fetchFailed: false,
      },
    );

    const job = await repositories.researchJobs.findById(created.job.id);
    const events = await repositories.jobEvents.listForJob(created.job.id);

    expect(job).toMatchObject({
      status: "PARTIAL",
      successfulSources: 1,
      failedSources: 1,
    });
    expect(job?.completedAt).toBeInstanceOf(Date);
    expect(
      events.some((event) => event.eventType === "research_job.completed"),
    ).toBe(true);
  });
});

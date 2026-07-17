import type { ResearchJob, SourceDocument } from "@signalforge/database";
import type { HiringSignalExtractionResult } from "@signalforge/llm";
import { describe, expect, it, vi } from "vitest";

import {
  createHiringSignalRecordProcessor,
  createNormalizedContentProcessor,
} from "./llm-processors.js";

const now = new Date("2026-07-19T10:00:00.000Z");
const source: SourceDocument = {
  id: "69dbaa4d-64b8-4991-9314-2a8074b93fd8",
  researchJobId: "3f8b80d7-d42d-4439-826f-cd80b973fb81",
  sourceUrl: "https://example.com/jobs",
  normalizedUrl: "https://example.com/jobs",
  domain: "example.com",
  title: "Careers",
  rawContent: "Acme is hiring a Backend Engineer in Lagos.",
  contentHash: "a".repeat(64),
  canonicalUrl: null,
  metadata: null,
  outboundLinks: [],
  fetchStatus: "SUCCEEDED",
  fetchMode: "HTTP",
  fetchDurationMs: 100,
  llmProvider: null,
  llmModel: null,
  llmUsage: null,
  llmMetadata: null,
  llmProcessedAt: null,
  recordDuplicatesRemoved: 0,
  processingStatus: "PROCESSING",
  processingAttempt: 0,
  httpStatus: 200,
  fetchedAt: now,
  errorCode: null,
  errorMessage: null,
  createdAt: now,
  updatedAt: now,
};

const job: ResearchJob = {
  id: source.researchJobId,
  query: "Find backend hiring signals",
  status: "RUNNING",
  requestedSources: [source.sourceUrl],
  extractionSchema: {
    title: "companyHiringSignal",
    type: "object",
    properties: {},
    required: [
      "company",
      "website",
      "role",
      "location",
      "signal",
      "sourceUrl",
      "evidence",
    ],
    additionalProperties: false,
  },
  idempotencyKeyHash: null,
  requestFingerprint: null,
  totalSources: 1,
  successfulSources: 0,
  failedSources: 0,
  duplicatesRemoved: 0,
  startedAt: now,
  completedAt: null,
  createdAt: now,
  updatedAt: now,
};

const extraction: HiringSignalExtractionResult = {
  records: [
    {
      company: "Acme",
      website: null,
      role: "Backend Engineer",
      location: "Lagos",
      signal: "Hiring a backend engineer",
      sourceUrl: source.sourceUrl,
      evidence: source.rawContent ?? "",
      confidenceScore: 0.9,
    },
  ],
  provider: "fake",
  model: "test-model",
  chunkCount: 1,
  repairedChunks: 0,
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  responseMetadata: [{ requestId: "request-1" }],
};

describe("worker LLM processors", () => {
  it("maps validated signals and usage to one atomic persistence call", async () => {
    const extractor = { extract: vi.fn(async () => extraction) };
    const researchJobs = { findById: vi.fn(async () => job) };
    const extractedRecords = {
      mergeValidatedForSource: vi.fn(async () => ({
        canonicalRecordCount: 1,
        duplicatesRemoved: 0,
      })),
    };
    const processor = createHiringSignalRecordProcessor(
      extractor,
      researchJobs,
      extractedRecords,
    );

    await processor.process(source, new AbortController().signal);

    expect(extractedRecords.mergeValidatedForSource).toHaveBeenCalledWith(
      source.researchJobId,
      source.id,
      0,
      [
        expect.objectContaining({
          structuredData: {
            company: "Acme",
            website: null,
            role: "Backend Engineer",
            location: "Lagos",
            signal: "Hiring a backend engineer",
            sourceUrl: source.sourceUrl,
            evidence: source.rawContent,
          },
          evidence: [{ quote: source.rawContent }],
          confidenceScore: 0.9,
          relevanceScore: expect.any(Number),
          sourceAttributions: [
            {
              sourceDocumentId: source.id,
              sourceUrl: source.sourceUrl,
              evidence: [source.rawContent],
              publishedAt: null,
              credibilityScore: null,
            },
          ],
        }),
      ],
      {
        provider: "fake",
        model: "test-model",
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        metadata: {
          chunkCount: 1,
          repairedChunks: 0,
          responseMetadata: [{ requestId: "request-1" }],
          recordProcessing: {
            duplicatesRemoved: 0,
            conflictsDetected: 0,
            semanticMatchingUsed: false,
          },
        },
        duplicatesRemoved: 0,
      },
    );
  });

  it("rejects unsupported research schemas before invoking the provider", async () => {
    const extractor = { extract: vi.fn(async () => extraction) };
    const processor = createHiringSignalRecordProcessor(
      extractor,
      {
        findById: vi.fn(async () => ({
          ...job,
          extractionSchema: { title: "arbitraryRecord", required: ["name"] },
        })),
      },
      {
        mergeValidatedForSource: vi.fn(async () => ({
          canonicalRecordCount: 0,
          duplicatesRemoved: 0,
        })),
      },
    );

    await expect(
      processor.process(source, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_EXTRACTION_SCHEMA",
      retryable: false,
    });
    expect(extractor.extract).not.toHaveBeenCalled();
  });

  it("rejects an empty normalized document before record processing", async () => {
    await expect(
      createNormalizedContentProcessor().extract(
        { ...source, rawContent: "" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ retryable: false });
  });
});

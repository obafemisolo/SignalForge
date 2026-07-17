import type { SourceDocument } from "@signalforge/database";
import type {
  PipelineQueuePublisher,
  ResearchOrchestrationJobData,
  SourceStageJobData,
} from "@signalforge/queue";
import { UnrecoverableError, type Job } from "bullmq";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  PipelineJobProcessor,
  type PipelineProcessors,
  type PipelineStore,
} from "./pipeline.js";

const data: SourceStageJobData = {
  researchJobId: "3f8b80d7-d42d-4439-826f-cd80b973fb81",
  sourceDocumentId: "69dbaa4d-64b8-4991-9314-2a8074b93fd8",
  pipelineAttempt: 0,
  requestedAt: "2026-07-18T10:00:00.000Z",
  requestId: "07883774-668f-449c-a84a-bc35fcf8e588",
  timeoutMs: 5_000,
};

function source(status: SourceDocument["processingStatus"]): SourceDocument {
  const now = new Date("2026-07-18T10:00:00.000Z");
  return {
    id: data.sourceDocumentId,
    researchJobId: data.researchJobId,
    sourceUrl: "https://example.com/jobs",
    normalizedUrl: "https://example.com/jobs",
    domain: "example.com",
    title: null,
    rawContent: status === "FETCHING" ? null : "Readable content",
    contentHash: null,
    canonicalUrl: null,
    metadata: null,
    outboundLinks: [],
    fetchStatus: status === "FETCHING" ? "FETCHING" : "SUCCEEDED",
    fetchMode: null,
    fetchDurationMs: null,
    llmProvider: null,
    llmModel: null,
    llmUsage: null,
    llmMetadata: null,
    llmProcessedAt: null,
    recordDuplicatesRemoved: 0,
    processingStatus: status,
    processingAttempt: 0,
    httpStatus: null,
    fetchedAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  };
}

function store(current: SourceDocument): PipelineStore {
  return {
    startOrchestration: vi.fn(),
    findSource: vi.fn(async () => current),
    markFetchStarted: vi.fn(async () => true),
    markFetchSucceeded: vi.fn(async () => true),
    markExtractionSucceeded: vi.fn(async () => true),
    completeSource: vi.fn(async () => null),
    failSource: vi.fn(async () => null),
    failOrchestration: vi.fn(async () => ({
      successfulSources: 0,
      failedSources: 1,
      terminalSources: 1,
      status: "FAILED" as const,
      isTerminal: true,
    })),
  };
}

function publisher(): PipelineQueuePublisher {
  return {
    enqueueResearchJob: vi.fn(async () => undefined),
    enqueueFailedSourceRetry: vi.fn(async () => undefined),
    enqueueSourceFetchJobs: vi.fn(async () => undefined),
    enqueueContentExtraction: vi.fn(async () => undefined),
    enqueueRecordProcessing: vi.fn(async () => undefined),
    enqueueDeadLetter: vi.fn(async () => undefined),
    checkHealth: vi.fn(async () => true),
    checkWorkerHealth: vi.fn(async () => true),
    getQueueDepths: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
  };
}

function processors(
  fetch: PipelineProcessors["sourceFetcher"]["fetch"] = vi.fn(async () => ({
    rawContent: "Readable content",
    contentHash: "a".repeat(64),
    httpStatus: 200,
    fetchedAt: new Date(),
  })),
): PipelineProcessors {
  return {
    sourceFetcher: { fetch },
    contentExtractor: { extract: vi.fn(async () => undefined) },
    recordProcessor: { process: vi.fn(async () => undefined) },
  };
}

function fetchJob(attemptsMade: number, attempts = 2) {
  return {
    id: `fetch-${data.sourceDocumentId}-0`,
    name: "source.fetch",
    queueName: "source-fetch",
    data,
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<SourceStageJobData, void, "source.fetch">;
}

function stageJob<Name extends "content.extract" | "record.process">(
  name: Name,
) {
  return {
    id: `${name}-${data.sourceDocumentId}-0`,
    name,
    queueName:
      name === "content.extract" ? "content-extraction" : "record-processing",
    data,
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as unknown as Job<SourceStageJobData, void, Name>;
}

function orchestrationJob() {
  const orchestrationData: ResearchOrchestrationJobData = {
    researchJobId: data.researchJobId,
    requestedAt: data.requestedAt,
    requestId: data.requestId,
    timeoutMs: 5_000,
  };
  return {
    id: `orchestrate-${data.researchJobId}`,
    name: "research-job.orchestrate",
    queueName: "research-orchestration",
    data: orchestrationData,
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as unknown as Job<ResearchOrchestrationJobData, void, string>;
}

describe("pipeline retry and idempotency behavior", () => {
  it("leaves a transient failure non-terminal so BullMQ can retry it", async () => {
    const repository = store(source("FETCHING"));
    const queues = publisher();
    const processor = new PipelineJobProcessor(
      repository,
      queues,
      processors(async () => {
        throw new Error("temporary network failure");
      }),
      pino({ level: "silent" }),
    );

    await expect(processor.processSourceFetch(fetchJob(0))).rejects.toThrow(
      "temporary network failure",
    );
    expect(repository.failSource).not.toHaveBeenCalled();
    expect(queues.enqueueDeadLetter).not.toHaveBeenCalled();
  });

  it("marks and dead-letters a source after its final attempt", async () => {
    const repository = store(source("FETCHING"));
    const queues = publisher();
    const processor = new PipelineJobProcessor(
      repository,
      queues,
      processors(async () => {
        throw new Error("permanent network failure");
      }),
      pino({ level: "silent" }),
    );

    await expect(
      processor.processSourceFetch(fetchJob(1)),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(repository.failSource).toHaveBeenCalledOnce();
    expect(queues.enqueueDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({
        queueName: "source-fetch",
        sourceDocumentId: data.sourceDocumentId,
        attemptsMade: 2,
      }),
    );
  });

  it("does not retry a classified permanent fetch failure", async () => {
    const repository = store(source("FETCHING"));
    const queues = publisher();
    const error = Object.assign(new Error("robots.txt denied this URL"), {
      code: "ROBOTS_DISALLOWED",
      retryable: false,
      fetchStatus: "SKIPPED" as const,
      fetchMode: "HTTP" as const,
      fetchDurationMs: 12,
    });
    const processor = new PipelineJobProcessor(
      repository,
      queues,
      processors(async () => {
        throw error;
      }),
      pino({ level: "silent" }),
    );

    await expect(
      processor.processSourceFetch(fetchJob(0)),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(repository.failSource).toHaveBeenCalledWith(
      data.sourceDocumentId,
      0,
      expect.objectContaining({
        errorCode: "ROBOTS_DISALLOWED",
        fetchStatus: "SKIPPED",
        fetchDurationMs: 12,
      }),
    );
  });

  it("does not process a source already completed before a worker restart", async () => {
    const repository = store(source("SUCCEEDED"));
    const queues = publisher();
    const stageProcessors = processors();
    const processor = new PipelineJobProcessor(
      repository,
      queues,
      stageProcessors,
      pino({ level: "silent" }),
    );

    await processor.processSourceFetch(fetchJob(0));

    expect(stageProcessors.sourceFetcher.fetch).not.toHaveBeenCalled();
    expect(repository.markFetchStarted).not.toHaveBeenCalled();
    expect(queues.enqueueContentExtraction).not.toHaveBeenCalled();
  });

  it("repairs a downstream enqueue after fetch persistence succeeded", async () => {
    const repository = store(source("EXTRACTING"));
    const queues = publisher();
    const processor = new PipelineJobProcessor(
      repository,
      queues,
      processors(),
      pino({ level: "silent" }),
    );

    await processor.processSourceFetch(fetchJob(0));

    expect(queues.enqueueContentExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceDocumentId: data.sourceDocumentId,
        pipelineAttempt: 0,
      }),
    );
  });

  it("fans orchestration out into one source job per persisted source", async () => {
    const repository = store(source("PENDING"));
    repository.startOrchestration = vi.fn(async () => ({
      job: { id: data.researchJobId },
      sources: [
        {
          id: data.sourceDocumentId,
          normalizedUrl: "https://example.com/jobs",
          processingAttempt: 0,
          processingStatus: "PENDING",
        },
        {
          id: "b5c563ce-e97e-4138-b440-19be07b8c888",
          normalizedUrl: "https://example.org/jobs",
          processingAttempt: 0,
          processingStatus: "PENDING",
        },
      ],
    })) as unknown as PipelineStore["startOrchestration"];
    const queues = publisher();
    const processor = new PipelineJobProcessor(
      repository,
      queues,
      processors(),
      pino({ level: "silent" }),
    );

    await processor.processOrchestration(orchestrationJob());

    expect(queues.enqueueSourceFetchJobs).toHaveBeenCalledWith([
      expect.objectContaining({ sourceDocumentId: data.sourceDocumentId }),
      expect.objectContaining({
        sourceDocumentId: "b5c563ce-e97e-4138-b440-19be07b8c888",
      }),
    ]);
  });

  it("chains extraction into record processing", async () => {
    const repository = store(source("EXTRACTING"));
    const queues = publisher();
    const stageProcessors = processors();
    const processor = new PipelineJobProcessor(
      repository,
      queues,
      stageProcessors,
      pino({ level: "silent" }),
    );

    await processor.processContentExtraction(stageJob("content.extract"));

    expect(stageProcessors.contentExtractor.extract).toHaveBeenCalledOnce();
    expect(repository.markExtractionSucceeded).toHaveBeenCalledOnce();
    expect(queues.enqueueRecordProcessing).toHaveBeenCalledWith(
      expect.objectContaining({ sourceDocumentId: data.sourceDocumentId }),
    );
  });

  it("marks the source terminal only after record processing succeeds", async () => {
    const repository = store(source("PROCESSING"));
    const queues = publisher();
    const stageProcessors = processors();
    const processor = new PipelineJobProcessor(
      repository,
      queues,
      stageProcessors,
      pino({ level: "silent" }),
    );

    await processor.processRecordProcessing(stageJob("record.process"));

    expect(stageProcessors.recordProcessor.process).toHaveBeenCalledOnce();
    expect(repository.completeSource).toHaveBeenCalledWith(
      data.sourceDocumentId,
      0,
    );
  });
});

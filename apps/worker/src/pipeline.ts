import {
  type PipelineFailureInput,
  type PipelineRepository,
  type SourceDocument,
} from "@signalforge/database";
import type { Logger } from "@signalforge/observability";
import {
  QUEUE_NAMES,
  type PipelineQueuePublisher,
  type PipelineQueueName,
  type ResearchOrchestrationJobData,
  type SourceStageJobData,
} from "@signalforge/queue";
import type { SourceDocumentSuccessInput } from "@signalforge/schemas";
import { UnrecoverableError, type Job } from "bullmq";

export interface SourceFetcher {
  fetch(
    source: SourceDocument,
    signal: AbortSignal,
  ): Promise<SourceDocumentSuccessInput>;
}

export interface ContentExtractor {
  extract(source: SourceDocument, signal: AbortSignal): Promise<void>;
}

export interface RecordProcessor {
  process(source: SourceDocument, signal: AbortSignal): Promise<void>;
}

export interface PipelineProcessors {
  sourceFetcher: SourceFetcher;
  contentExtractor: ContentExtractor;
  recordProcessor: RecordProcessor;
}

export type PipelineStore = Pick<
  PipelineRepository,
  | "completeSource"
  | "failOrchestration"
  | "failSource"
  | "findSource"
  | "markExtractionSucceeded"
  | "markFetchStarted"
  | "markFetchSucceeded"
  | "startOrchestration"
>;

export class UnrecoverablePipelineError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnrecoverablePipelineError";
  }
}

export class PipelineJobProcessor {
  public constructor(
    private readonly repository: PipelineStore,
    private readonly publisher: PipelineQueuePublisher,
    private readonly processors: PipelineProcessors,
    private readonly logger: Logger,
  ) {}

  public async processOrchestration(
    job: Job<ResearchOrchestrationJobData, void, string>,
    workerSignal?: AbortSignal,
  ): Promise<void> {
    await this.executeWithFailurePolicy(
      job,
      QUEUE_NAMES.researchOrchestration,
      undefined,
      workerSignal,
      async () => {
        const work = await this.repository.startOrchestration(
          job.data.researchJobId,
          job.data.sourceDocumentIds,
        );
        await this.publisher.enqueueSourceFetchJobs(
          work.sources.map((source) => ({
            researchJobId: job.data.researchJobId,
            sourceDocumentId: source.id,
            pipelineAttempt: source.processingAttempt,
            requestedAt: job.data.requestedAt,
            requestId: job.data.requestId,
          })),
        );
      },
      async (error) => {
        await this.repository.failOrchestration(
          job.data.researchJobId,
          requiredJobId(job),
          error.message,
        );
      },
    );
  }

  public async processSourceFetch(
    job: Job<SourceStageJobData, void, "source.fetch">,
    workerSignal?: AbortSignal,
  ): Promise<void> {
    await this.executeWithFailurePolicy(
      job,
      QUEUE_NAMES.sourceFetch,
      job.data.sourceDocumentId,
      workerSignal,
      async (signal) => {
        let source = await this.requireCurrentSource(job.data);
        if (source === null || isTerminal(source.processingStatus)) {
          return;
        }
        if (source.processingStatus === "EXTRACTING") {
          await this.publisher.enqueueContentExtraction(
            nextStageData(job.data),
          );
          return;
        }
        if (
          source.processingStatus === "PROCESSING" ||
          source.processingStatus === "SUCCEEDED"
        ) {
          return;
        }

        await this.repository.markFetchStarted(
          source.id,
          job.data.pipelineAttempt,
        );
        source =
          (await this.repository.findSource(source.id)) ??
          throwMissingSource(source.id);
        const result = await this.processors.sourceFetcher.fetch(
          source,
          signal,
        );
        const changed = await this.repository.markFetchSucceeded(
          source.id,
          job.data.pipelineAttempt,
          result,
        );
        if (changed) {
          await this.publisher.enqueueContentExtraction(
            nextStageData(job.data),
          );
        }
      },
      (error) => this.failSource(job, error, true),
    );
  }

  public async processContentExtraction(
    job: Job<SourceStageJobData, void, "content.extract">,
    workerSignal?: AbortSignal,
  ): Promise<void> {
    await this.executeWithFailurePolicy(
      job,
      QUEUE_NAMES.contentExtraction,
      job.data.sourceDocumentId,
      workerSignal,
      async (signal) => {
        const source = await this.requireCurrentSource(job.data);
        if (source === null || isTerminal(source.processingStatus)) {
          return;
        }
        if (source.processingStatus === "PROCESSING") {
          await this.publisher.enqueueRecordProcessing(nextStageData(job.data));
          return;
        }
        if (source.processingStatus !== "EXTRACTING") {
          return;
        }

        await this.processors.contentExtractor.extract(source, signal);
        const changed = await this.repository.markExtractionSucceeded(
          source.id,
          job.data.pipelineAttempt,
        );
        if (changed) {
          await this.publisher.enqueueRecordProcessing(nextStageData(job.data));
        }
      },
      (error) => this.failSource(job, error, false),
    );
  }

  public async processRecordProcessing(
    job: Job<SourceStageJobData, void, "record.process">,
    workerSignal?: AbortSignal,
  ): Promise<void> {
    await this.executeWithFailurePolicy(
      job,
      QUEUE_NAMES.recordProcessing,
      job.data.sourceDocumentId,
      workerSignal,
      async (signal) => {
        const source = await this.requireCurrentSource(job.data);
        if (
          source === null ||
          isTerminal(source.processingStatus) ||
          source.processingStatus !== "PROCESSING"
        ) {
          return;
        }

        await this.processors.recordProcessor.process(source, signal);
        await this.repository.completeSource(
          source.id,
          job.data.pipelineAttempt,
        );
      },
      (error) => this.failSource(job, error, false),
    );
  }

  private async requireCurrentSource(
    data: SourceStageJobData,
  ): Promise<SourceDocument | null> {
    const source = await this.repository.findSource(data.sourceDocumentId);
    if (source === null) {
      throw new UnrecoverablePipelineError(
        `SourceDocument ${data.sourceDocumentId} was not found`,
      );
    }
    if (source.processingAttempt !== data.pipelineAttempt) {
      return null;
    }
    return source;
  }

  private async failSource(
    job: Job<SourceStageJobData, void, string>,
    error: Error,
    fetchFailed: boolean,
  ): Promise<void> {
    const input: PipelineFailureInput = {
      queueName: job.queueName,
      jobId: requiredJobId(job),
      errorCode: `${job.queueName.toUpperCase().replaceAll("-", "_")}_FAILED`,
      errorMessage: error.message,
      fetchFailed,
    };
    await this.repository.failSource(
      job.data.sourceDocumentId,
      job.data.pipelineAttempt,
      input,
    );
  }

  private async executeWithFailurePolicy<
    Data extends ResearchOrchestrationJobData | SourceStageJobData,
  >(
    job: Job<Data, void, string>,
    queueName: Exclude<PipelineQueueName, "dead-letter">,
    sourceDocumentId: string | undefined,
    workerSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<void>,
    onPermanentFailure: (error: Error) => Promise<void>,
  ): Promise<void> {
    const attemptNumber = job.attemptsMade + 1;
    const context = {
      jobId: requiredJobId(job),
      researchJobId: job.data.researchJobId,
      sourceDocumentId,
      attemptNumber,
      queueName,
    };
    this.logger.info(context, "Worker job started");

    try {
      await withTimeout(job.data.timeoutMs, workerSignal, operation);
      this.logger.info(context, "Worker job completed");
    } catch (caught: unknown) {
      const error = toError(caught);
      const permanent =
        error instanceof UnrecoverablePipelineError ||
        attemptNumber >= (job.opts.attempts ?? 1);

      if (!permanent) {
        this.logger.warn({ ...context, err: error }, "Worker job will retry");
        throw error;
      }

      await onPermanentFailure(error);
      await this.publisher.enqueueDeadLetter({
        queueName,
        jobName: job.name,
        jobId: requiredJobId(job),
        researchJobId: job.data.researchJobId,
        ...(sourceDocumentId === undefined ? {} : { sourceDocumentId }),
        ...("pipelineAttempt" in job.data
          ? { pipelineAttempt: job.data.pipelineAttempt }
          : {}),
        attemptsMade: attemptNumber,
        failedAt: new Date().toISOString(),
        error: {
          name: error.name,
          message: error.message,
          ...(error.stack === undefined ? {} : { stack: error.stack }),
        },
      });
      this.logger.error(
        { ...context, err: error },
        "Worker job permanently failed",
      );
      throw new UnrecoverableError(error.message);
    }
  }
}

export function createUnavailableProcessors(): PipelineProcessors {
  const unavailable = (stage: string): never => {
    throw new UnrecoverablePipelineError(
      `${stage} processor is not implemented in Phase 4`,
    );
  };
  return {
    sourceFetcher: {
      fetch: async () => unavailable("Source fetch"),
    },
    contentExtractor: {
      extract: async () => unavailable("Content extraction"),
    },
    recordProcessor: {
      process: async () => unavailable("Record processing"),
    },
  };
}

async function withTimeout(
  timeoutMs: number,
  workerSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const onWorkerAbort = (): void => controller.abort(workerSignal?.reason);
  workerSignal?.addEventListener("abort", onWorkerAbort, { once: true });

  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`Job timed out after ${timeoutMs}ms`);
      error.name = "JobTimeoutError";
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    await Promise.race([operation(controller.signal), timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    workerSignal?.removeEventListener("abort", onWorkerAbort);
  }
}

function nextStageData(data: SourceStageJobData) {
  return {
    researchJobId: data.researchJobId,
    sourceDocumentId: data.sourceDocumentId,
    pipelineAttempt: data.pipelineAttempt,
    requestedAt: data.requestedAt,
    requestId: data.requestId,
  };
}

function isTerminal(status: string): boolean {
  return status === "SUCCEEDED" || status === "FAILED";
}

function requiredJobId(job: Job): string {
  if (job.id === undefined) {
    throw new UnrecoverablePipelineError("BullMQ job has no ID");
  }
  return job.id;
}

function throwMissingSource(sourceDocumentId: string): never {
  throw new UnrecoverablePipelineError(
    `SourceDocument ${sourceDocumentId} was not found`,
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

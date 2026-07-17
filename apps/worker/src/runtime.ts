import type { Logger, SignalForgeMetrics } from "@signalforge/observability";
import {
  CONTENT_EXTRACTION_QUEUE,
  RECORD_PROCESSING_QUEUE,
  RESEARCH_ORCHESTRATION_QUEUE,
  SOURCE_FETCH_QUEUE,
  researchOrchestrationJobDataSchema,
  researchOrchestrationJobNameSchema,
  sourceStageJobDataSchema,
  type ResearchOrchestrationJobData,
  type SourceStageJobData,
} from "@signalforge/queue";
import type { WorkerHeartbeat } from "@signalforge/queue";
import { UnrecoverableError, Worker, type ConnectionOptions } from "bullmq";

import type { PipelineJobProcessor } from "./pipeline.js";

export interface WorkerConcurrency {
  orchestration: number;
  sourceFetch: number;
  contentExtraction: number;
  recordProcessing: number;
}

export interface WorkerRuntimeOptions {
  stalledIntervalMs?: number;
  maxStalledCount?: number;
  lockDurationMs?: number;
  metrics?: SignalForgeMetrics;
  heartbeat?: WorkerHeartbeat;
}

export interface Closable {
  close(): Promise<void>;
}

export class WorkerRuntime implements Closable {
  public constructor(
    private readonly workers: readonly Closable[],
    private readonly afterWorkersClose: readonly Closable[] = [],
  ) {}

  public async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    for (const resource of this.afterWorkersClose) {
      await resource.close();
    }
  }
}

export function createBullMqWorkers(
  connection: ConnectionOptions,
  processor: PipelineJobProcessor,
  concurrency: WorkerConcurrency,
  logger: Logger,
  options: WorkerRuntimeOptions = {},
): WorkerRuntime {
  const workerOptions = {
    connection,
    stalledInterval: options.stalledIntervalMs ?? 30_000,
    maxStalledCount: options.maxStalledCount ?? 2,
    lockDuration: options.lockDurationMs ?? 120_000,
  };
  const orchestrationWorker = new Worker<
    ResearchOrchestrationJobData,
    void,
    string
  >(
    RESEARCH_ORCHESTRATION_QUEUE,
    (job, _token, signal) => {
      assertQueuePayload(
        researchOrchestrationJobNameSchema,
        researchOrchestrationJobDataSchema,
        job.name,
        job.data,
        "research-orchestration",
      );
      return processor.processOrchestration(job, signal ?? undefined);
    },
    { ...workerOptions, concurrency: concurrency.orchestration },
  );
  const sourceFetchWorker = new Worker<
    SourceStageJobData,
    void,
    "source.fetch"
  >(
    SOURCE_FETCH_QUEUE,
    (job, _token, signal) => {
      assertStagePayload(job.name, "source.fetch", job.data, "source-fetch");
      return processor.processSourceFetch(job, signal ?? undefined);
    },
    { ...workerOptions, concurrency: concurrency.sourceFetch },
  );
  const contentExtractionWorker = new Worker<
    SourceStageJobData,
    void,
    "content.extract"
  >(
    CONTENT_EXTRACTION_QUEUE,
    (job, _token, signal) => {
      assertStagePayload(
        job.name,
        "content.extract",
        job.data,
        "content-extraction",
      );
      return processor.processContentExtraction(job, signal ?? undefined);
    },
    { ...workerOptions, concurrency: concurrency.contentExtraction },
  );
  const recordProcessingWorker = new Worker<
    SourceStageJobData,
    void,
    "record.process"
  >(
    RECORD_PROCESSING_QUEUE,
    (job, _token, signal) => {
      assertStagePayload(
        job.name,
        "record.process",
        job.data,
        "record-processing",
      );
      return processor.processRecordProcessing(job, signal ?? undefined);
    },
    { ...workerOptions, concurrency: concurrency.recordProcessing },
  );
  const workers = [
    orchestrationWorker,
    sourceFetchWorker,
    contentExtractionWorker,
    recordProcessingWorker,
  ];

  for (const worker of workers) {
    worker.on("error", (error) => {
      logger.error(
        {
          err: error,
          queueName: worker.name,
          errorCode: "BULLMQ_WORKER_ERROR",
        },
        "BullMQ worker error",
      );
    });
    worker.on("stalled", (jobId) => {
      options.metrics?.observeRetry(worker.name, "stalled");
      logger.warn(
        { queueName: worker.name, jobId, errorCode: "JOB_STALLED" },
        "BullMQ job stalled and will be recovered",
      );
    });
  }

  return new WorkerRuntime(
    workers,
    options.heartbeat === undefined ? [] : [options.heartbeat],
  );
}

export function assertQueuePayload<TName extends string, TData>(
  nameSchema: { parse(value: unknown): TName },
  dataSchema: { parse(value: unknown): TData },
  name: unknown,
  data: unknown,
  queueName: string,
): asserts data is TData {
  try {
    nameSchema.parse(name);
    dataSchema.parse(data);
  } catch {
    throw new UnrecoverableError(`Invalid ${queueName} job payload`);
  }
}

function assertStagePayload(
  name: unknown,
  expectedName: string,
  data: unknown,
  queueName: string,
): asserts data is SourceStageJobData {
  if (name !== expectedName) {
    throw new UnrecoverableError(`Invalid ${queueName} job payload`);
  }
  try {
    sourceStageJobDataSchema.parse(data);
  } catch {
    throw new UnrecoverableError(`Invalid ${queueName} job payload`);
  }
}

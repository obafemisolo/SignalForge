import type { Logger } from "@signalforge/observability";
import {
  CONTENT_EXTRACTION_QUEUE,
  RECORD_PROCESSING_QUEUE,
  RESEARCH_ORCHESTRATION_QUEUE,
  SOURCE_FETCH_QUEUE,
  type ResearchOrchestrationJobData,
  type SourceStageJobData,
} from "@signalforge/queue";
import { Worker, type ConnectionOptions } from "bullmq";

import type { PipelineJobProcessor } from "./pipeline.js";

export interface WorkerConcurrency {
  orchestration: number;
  sourceFetch: number;
  contentExtraction: number;
  recordProcessing: number;
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
): WorkerRuntime {
  const orchestrationWorker = new Worker<
    ResearchOrchestrationJobData,
    void,
    string
  >(
    RESEARCH_ORCHESTRATION_QUEUE,
    (job, _token, signal) =>
      processor.processOrchestration(job, signal ?? undefined),
    { connection, concurrency: concurrency.orchestration },
  );
  const sourceFetchWorker = new Worker<
    SourceStageJobData,
    void,
    "source.fetch"
  >(
    SOURCE_FETCH_QUEUE,
    (job, _token, signal) =>
      processor.processSourceFetch(job, signal ?? undefined),
    { connection, concurrency: concurrency.sourceFetch },
  );
  const contentExtractionWorker = new Worker<
    SourceStageJobData,
    void,
    "content.extract"
  >(
    CONTENT_EXTRACTION_QUEUE,
    (job, _token, signal) =>
      processor.processContentExtraction(job, signal ?? undefined),
    { connection, concurrency: concurrency.contentExtraction },
  );
  const recordProcessingWorker = new Worker<
    SourceStageJobData,
    void,
    "record.process"
  >(
    RECORD_PROCESSING_QUEUE,
    (job, _token, signal) =>
      processor.processRecordProcessing(job, signal ?? undefined),
    { connection, concurrency: concurrency.recordProcessing },
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
        { err: error, queueName: worker.name },
        "BullMQ worker error",
      );
    });
  }

  return new WorkerRuntime(workers);
}

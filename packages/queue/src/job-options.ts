import type { JobsOptions } from "bullmq";

import type { PipelineQueueName } from "./contracts.js";
import { QUEUE_NAMES } from "./contracts.js";

export const QUEUE_ATTEMPTS: Readonly<Record<PipelineQueueName, number>> = {
  [QUEUE_NAMES.researchOrchestration]: 3,
  [QUEUE_NAMES.sourceFetch]: 4,
  [QUEUE_NAMES.contentExtraction]: 3,
  [QUEUE_NAMES.recordProcessing]: 3,
  [QUEUE_NAMES.deadLetter]: 1,
};

export interface QueueRetention {
  completedAgeSeconds: number;
  completedCount: number;
  failedAgeSeconds: number;
  failedCount: number;
}

export const defaultQueueRetention: QueueRetention = {
  completedAgeSeconds: 86_400,
  completedCount: 10_000,
  failedAgeSeconds: 604_800,
  failedCount: 20_000,
};

export function getJobOptions(
  queueName: PipelineQueueName,
  jobId: string,
  retention: QueueRetention = defaultQueueRetention,
): JobsOptions {
  return {
    jobId,
    attempts: QUEUE_ATTEMPTS[queueName],
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: {
      age: retention.completedAgeSeconds,
      count: retention.completedCount,
    },
    removeOnFail: {
      age: retention.failedAgeSeconds,
      count: retention.failedCount,
    },
  };
}

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

export function getJobOptions(
  queueName: PipelineQueueName,
  jobId: string,
): JobsOptions {
  return {
    jobId,
    attempts: QUEUE_ATTEMPTS[queueName],
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: { age: 604_800, count: 20_000 },
  };
}

import { z } from "zod";

import { persistenceIdSchema } from "@signalforge/schemas";

export const QUEUE_NAMES = {
  researchOrchestration: "research-orchestration",
  sourceFetch: "source-fetch",
  contentExtraction: "content-extraction",
  recordProcessing: "record-processing",
  deadLetter: "dead-letter",
} as const;

export type PipelineQueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const RESEARCH_ORCHESTRATION_QUEUE = QUEUE_NAMES.researchOrchestration;
export const SOURCE_FETCH_QUEUE = QUEUE_NAMES.sourceFetch;
export const CONTENT_EXTRACTION_QUEUE = QUEUE_NAMES.contentExtraction;
export const RECORD_PROCESSING_QUEUE = QUEUE_NAMES.recordProcessing;
export const DEAD_LETTER_QUEUE = QUEUE_NAMES.deadLetter;

const baseJobDataSchema = z
  .object({
    researchJobId: persistenceIdSchema,
    requestedAt: z.string().datetime(),
    requestId: z.string().uuid(),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(15 * 60_000),
  })
  .strict();

export const researchOrchestrationJobNameSchema = z.enum([
  "research-job.orchestrate",
  "research-job.retry-failed-sources",
]);

export const researchOrchestrationJobDataSchema = baseJobDataSchema.extend({
  sourceDocumentIds: z.array(persistenceIdSchema).min(1).max(100).optional(),
});

export const sourceStageJobDataSchema = baseJobDataSchema.extend({
  sourceDocumentId: persistenceIdSchema,
  pipelineAttempt: z.number().int().nonnegative(),
});

export const deadLetterJobDataSchema = z
  .object({
    queueName: z.enum([
      QUEUE_NAMES.researchOrchestration,
      QUEUE_NAMES.sourceFetch,
      QUEUE_NAMES.contentExtraction,
      QUEUE_NAMES.recordProcessing,
    ]),
    jobName: z.string().min(1).max(100),
    jobId: z.string().min(1).max(256),
    researchJobId: persistenceIdSchema,
    sourceDocumentId: persistenceIdSchema.optional(),
    pipelineAttempt: z.number().int().nonnegative().optional(),
    attemptsMade: z.number().int().positive(),
    failedAt: z.string().datetime(),
    error: z
      .object({
        name: z.string().min(1).max(100),
        message: z.string().min(1).max(10_000),
        stack: z.string().max(20_000).optional(),
      })
      .strict(),
  })
  .strict();

export type ResearchOrchestrationJobName = z.infer<
  typeof researchOrchestrationJobNameSchema
>;
export type ResearchOrchestrationJobData = z.infer<
  typeof researchOrchestrationJobDataSchema
>;
export type SourceStageJobData = z.infer<typeof sourceStageJobDataSchema>;
export type DeadLetterJobData = z.infer<typeof deadLetterJobDataSchema>;

export type ResearchOrchestrationRequest = Omit<
  ResearchOrchestrationJobData,
  "timeoutMs"
>;
export type SourceStageJobRequest = Omit<SourceStageJobData, "timeoutMs">;

export interface QueueTimeouts {
  orchestrationMs: number;
  sourceFetchMs: number;
  contentExtractionMs: number;
  recordProcessingMs: number;
}

export interface ResearchOrchestrationQueue {
  enqueueResearchJob(data: ResearchOrchestrationRequest): Promise<void>;
  enqueueFailedSourceRetry(
    data: ResearchOrchestrationRequest & {
      sourceDocumentIds: string[];
    },
  ): Promise<void>;
  checkHealth(): Promise<boolean>;
  checkWorkerHealth(maxAgeMs: number): Promise<boolean>;
  getQueueDepths(): Promise<QueueDepthSnapshot[]>;
  close(): Promise<void>;
}

export interface QueueDepthSnapshot {
  queueName: PipelineQueueName;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface PipelineQueuePublisher extends ResearchOrchestrationQueue {
  enqueueSourceFetchJobs(data: SourceStageJobRequest[]): Promise<void>;
  enqueueContentExtraction(data: SourceStageJobRequest): Promise<void>;
  enqueueRecordProcessing(data: SourceStageJobRequest): Promise<void>;
  enqueueDeadLetter(data: DeadLetterJobData): Promise<void>;
}

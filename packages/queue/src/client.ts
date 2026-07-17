import { Queue } from "bullmq";
import { Redis } from "ioredis";

import {
  CONTENT_EXTRACTION_QUEUE,
  DEAD_LETTER_QUEUE,
  QUEUE_NAMES,
  RECORD_PROCESSING_QUEUE,
  RESEARCH_ORCHESTRATION_QUEUE,
  SOURCE_FETCH_QUEUE,
  deadLetterJobDataSchema,
  researchOrchestrationJobDataSchema,
  sourceStageJobDataSchema,
  type DeadLetterJobData,
  type PipelineQueuePublisher,
  type QueueDepthSnapshot,
  type QueueTimeouts,
  type ResearchOrchestrationJobData,
  type ResearchOrchestrationJobName,
  type ResearchOrchestrationRequest,
  type SourceStageJobData,
  type SourceStageJobRequest,
} from "./contracts.js";
import {
  defaultQueueRetention,
  getJobOptions,
  type QueueRetention,
} from "./job-options.js";
import { WORKER_HEARTBEAT_KEY } from "./heartbeat.js";
import {
  contentExtractionJobId,
  deadLetterJobId,
  orchestrationJobId,
  recordProcessingJobId,
  sourceFetchJobId,
} from "./job-ids.js";

export interface BullMqQueueSystemOptions {
  redisUrl: string;
  prefix?: string;
  timeouts?: Partial<QueueTimeouts>;
  retention?: Partial<QueueRetention>;
}

const defaultTimeouts: QueueTimeouts = {
  orchestrationMs: 30_000,
  sourceFetchMs: 30_000,
  contentExtractionMs: 60_000,
  recordProcessingMs: 90_000,
};

export class BullMqQueueSystem implements PipelineQueuePublisher {
  private readonly redis: Redis;
  private readonly timeouts: QueueTimeouts;
  private readonly retention: QueueRetention;
  private readonly orchestrationQueue: Queue<
    ResearchOrchestrationJobData,
    void,
    ResearchOrchestrationJobName
  >;
  private readonly sourceFetchQueue: Queue<
    SourceStageJobData,
    void,
    "source.fetch"
  >;
  private readonly contentExtractionQueue: Queue<
    SourceStageJobData,
    void,
    "content.extract"
  >;
  private readonly recordProcessingQueue: Queue<
    SourceStageJobData,
    void,
    "record.process"
  >;
  private readonly deadLetterQueue: Queue<
    DeadLetterJobData,
    void,
    "job.dead-lettered"
  >;

  public constructor(options: BullMqQueueSystemOptions) {
    this.timeouts = { ...defaultTimeouts, ...options.timeouts };
    this.retention = { ...defaultQueueRetention, ...options.retention };
    this.redis = createProducerRedisConnection(options.redisUrl);
    const connection = this.redis;
    const queueOptions = {
      connection,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    };
    this.orchestrationQueue = new Queue(RESEARCH_ORCHESTRATION_QUEUE, {
      ...queueOptions,
    });
    this.sourceFetchQueue = new Queue(SOURCE_FETCH_QUEUE, queueOptions);
    this.contentExtractionQueue = new Queue(CONTENT_EXTRACTION_QUEUE, {
      ...queueOptions,
    });
    this.recordProcessingQueue = new Queue(RECORD_PROCESSING_QUEUE, {
      ...queueOptions,
    });
    this.deadLetterQueue = new Queue(DEAD_LETTER_QUEUE, queueOptions);
  }

  public async enqueueResearchJob(
    data: ResearchOrchestrationRequest,
  ): Promise<void> {
    const payload = researchOrchestrationJobDataSchema.parse({
      ...data,
      timeoutMs: this.timeouts.orchestrationMs,
    });
    await this.orchestrationQueue.add(
      "research-job.orchestrate",
      payload,
      getJobOptions(
        QUEUE_NAMES.researchOrchestration,
        orchestrationJobId(data),
        this.retention,
      ),
    );
  }

  public async enqueueFailedSourceRetry(
    data: ResearchOrchestrationRequest & { sourceDocumentIds: string[] },
  ): Promise<void> {
    const payload = researchOrchestrationJobDataSchema.parse({
      ...data,
      timeoutMs: this.timeouts.orchestrationMs,
    });
    await this.orchestrationQueue.add(
      "research-job.retry-failed-sources",
      payload,
      getJobOptions(
        QUEUE_NAMES.researchOrchestration,
        orchestrationJobId(data),
        this.retention,
      ),
    );
  }

  public async enqueueSourceFetchJobs(
    data: SourceStageJobRequest[],
  ): Promise<void> {
    if (data.length === 0) {
      return;
    }

    await this.sourceFetchQueue.addBulk(
      data.map((item) => {
        const payload = sourceStageJobDataSchema.parse({
          ...item,
          timeoutMs: this.timeouts.sourceFetchMs,
        });
        return {
          name: "source.fetch" as const,
          data: payload,
          opts: getJobOptions(
            QUEUE_NAMES.sourceFetch,
            sourceFetchJobId(payload),
            this.retention,
          ),
        };
      }),
    );
  }

  public async enqueueContentExtraction(
    data: SourceStageJobRequest,
  ): Promise<void> {
    const payload = sourceStageJobDataSchema.parse({
      ...data,
      timeoutMs: this.timeouts.contentExtractionMs,
    });
    await this.contentExtractionQueue.add(
      "content.extract",
      payload,
      getJobOptions(
        QUEUE_NAMES.contentExtraction,
        contentExtractionJobId(payload),
        this.retention,
      ),
    );
  }

  public async enqueueRecordProcessing(
    data: SourceStageJobRequest,
  ): Promise<void> {
    const payload = sourceStageJobDataSchema.parse({
      ...data,
      timeoutMs: this.timeouts.recordProcessingMs,
    });
    await this.recordProcessingQueue.add(
      "record.process",
      payload,
      getJobOptions(
        QUEUE_NAMES.recordProcessing,
        recordProcessingJobId(payload),
        this.retention,
      ),
    );
  }

  public async enqueueDeadLetter(data: DeadLetterJobData): Promise<void> {
    const payload = deadLetterJobDataSchema.parse(data);
    await this.deadLetterQueue.add(
      "job.dead-lettered",
      payload,
      getJobOptions(
        QUEUE_NAMES.deadLetter,
        deadLetterJobId(payload),
        this.retention,
      ),
    );
  }

  public async checkHealth(): Promise<boolean> {
    try {
      if (this.redis.status === "wait") {
        await this.redis.connect();
      }
      return (await this.redis.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  public async checkWorkerHealth(maxAgeMs: number): Promise<boolean> {
    try {
      if (this.redis.status === "wait") {
        await this.redis.connect();
      }
      const cutoff = Date.now() - maxAgeMs;
      await this.redis.zremrangebyscore(WORKER_HEARTBEAT_KEY, 0, cutoff);
      return (await this.redis.zcard(WORKER_HEARTBEAT_KEY)) > 0;
    } catch {
      return false;
    }
  }

  public async getQueueDepths(): Promise<QueueDepthSnapshot[]> {
    const queues = [
      this.orchestrationQueue,
      this.sourceFetchQueue,
      this.contentExtractionQueue,
      this.recordProcessingQueue,
      this.deadLetterQueue,
    ] as const;
    return Promise.all(
      queues.map(async (queue) => {
        const counts = await queue.getJobCounts(
          "waiting",
          "active",
          "delayed",
          "failed",
        );
        return {
          queueName: queue.name as QueueDepthSnapshot["queueName"],
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
        };
      }),
    );
  }

  public async close(): Promise<void> {
    await Promise.all([
      this.orchestrationQueue.close(),
      this.sourceFetchQueue.close(),
      this.contentExtractionQueue.close(),
      this.recordProcessingQueue.close(),
      this.deadLetterQueue.close(),
    ]);
    this.redis.disconnect();
  }
}

export const BullMqResearchOrchestrationQueue = BullMqQueueSystem;
export type BullMqResearchQueueOptions = BullMqQueueSystemOptions;

export function createProducerRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    connectTimeout: 5_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
}

export function createWorkerRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    connectTimeout: 5_000,
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
}

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { loadEnvironment } from "@signalforge/config";
import {
  connectDatabase,
  createDatabaseClient,
  createRepositories,
  disconnectDatabase,
} from "@signalforge/database";
import { createControlledWebExtractor } from "@signalforge/extraction";
import {
  HiringSignalExtractor,
  OpenAiCompatibleProvider,
} from "@signalforge/llm";
import { createLogger, createMetrics } from "@signalforge/observability";
import type { LlmProvider } from "@signalforge/llm";
import {
  BullMqQueueSystem,
  createWorkerRedisConnection,
  WorkerHeartbeat,
} from "@signalforge/queue";

import {
  PipelineJobProcessor,
  createUnavailableProcessors,
} from "./pipeline.js";
import {
  createHiringSignalRecordProcessor,
  createNormalizedContentProcessor,
} from "./llm-processors.js";
import { createBullMqWorkers } from "./runtime.js";
import { createWorkerOperationalServer } from "./metrics-server.js";

export * from "./pipeline.js";
export * from "./runtime.js";
export * from "./llm-processors.js";

export async function startWorker(): Promise<void> {
  const environment = loadEnvironment();
  const logger = createLogger({
    level: environment.LOG_LEVEL,
    service: "@signalforge/worker",
  });
  const metrics = createMetrics({ service: "@signalforge/worker" });
  const database = createDatabaseClient({
    databaseUrl: environment.DATABASE_URL,
  });
  const publisher = new BullMqQueueSystem({
    redisUrl: environment.REDIS_URL,
    timeouts: {
      orchestrationMs: environment.QUEUE_ORCHESTRATION_TIMEOUT_MS,
      sourceFetchMs: environment.QUEUE_SOURCE_FETCH_TIMEOUT_MS,
      contentExtractionMs: environment.QUEUE_CONTENT_EXTRACTION_TIMEOUT_MS,
      recordProcessingMs: environment.QUEUE_RECORD_PROCESSING_TIMEOUT_MS,
    },
    retention: {
      completedAgeSeconds: environment.QUEUE_COMPLETED_RETENTION_AGE_SECONDS,
      completedCount: environment.QUEUE_COMPLETED_RETENTION_COUNT,
      failedAgeSeconds: environment.QUEUE_FAILED_RETENTION_AGE_SECONDS,
      failedCount: environment.QUEUE_FAILED_RETENTION_COUNT,
    },
  });
  const workerRedis = createWorkerRedisConnection(environment.REDIS_URL);
  const heartbeat = new WorkerHeartbeat(workerRedis, {
    workerId: `${process.pid}-${randomUUID()}`,
    intervalMs: environment.WORKER_HEARTBEAT_INTERVAL_MS,
    ttlMs: environment.WORKER_HEARTBEAT_TTL_MS,
    onHeartbeat: (timestamp) => metrics.recordHeartbeat(timestamp),
    onError: (error) =>
      logger.error(
        { err: error, errorCode: "WORKER_HEARTBEAT_FAILED" },
        "Worker heartbeat failed",
      ),
  });
  const webExtractor = createControlledWebExtractor({
    userAgent: environment.EXTRACTION_USER_AGENT,
    maxBodyBytes: environment.EXTRACTION_MAX_BODY_BYTES,
    maxRedirects: environment.EXTRACTION_MAX_REDIRECTS,
    connectionTimeoutMs: environment.EXTRACTION_CONNECTION_TIMEOUT_MS,
    totalTimeoutMs: environment.EXTRACTION_TOTAL_TIMEOUT_MS,
    globalConcurrency: environment.EXTRACTION_GLOBAL_CONCURRENCY,
    domainConcurrency: environment.EXTRACTION_DOMAIN_CONCURRENCY,
    domainDelayMs: environment.EXTRACTION_DOMAIN_DELAY_MS,
    minimumContentCharacters: environment.EXTRACTION_MIN_CONTENT_CHARS,
    playwrightEnabled: environment.EXTRACTION_PLAYWRIGHT_ENABLED,
  });
  const llmProvider = new OpenAiCompatibleProvider({
    baseUrl: environment.LLM_BASE_URL,
    ...(environment.LLM_API_KEY === undefined
      ? {}
      : { apiKey: environment.LLM_API_KEY }),
    timeoutMs: environment.LLM_TIMEOUT_MS,
    pricing: {
      ...(environment.LLM_INPUT_COST_PER_MILLION_TOKENS === undefined
        ? {}
        : {
            inputCostPerMillionTokens:
              environment.LLM_INPUT_COST_PER_MILLION_TOKENS,
          }),
      ...(environment.LLM_OUTPUT_COST_PER_MILLION_TOKENS === undefined
        ? {}
        : {
            outputCostPerMillionTokens:
              environment.LLM_OUTPUT_COST_PER_MILLION_TOKENS,
          }),
    },
  });
  const instrumentedLlmProvider: LlmProvider = {
    name: llmProvider.name,
    complete: async (request) => {
      const startedAt = Date.now();
      try {
        const response = await llmProvider.complete(request);
        metrics.observeLlmRequest({
          provider: llmProvider.name,
          model: response.model,
          status: "success",
          durationMs: Date.now() - startedAt,
          ...response.usage,
        });
        return response;
      } catch (error: unknown) {
        metrics.observeLlmRequest({
          provider: llmProvider.name,
          model: request.model,
          status: "failure",
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    },
  };
  const hiringSignalExtractor = new HiringSignalExtractor(
    instrumentedLlmProvider,
    {
      model: environment.LLM_MODEL,
      maxOutputTokens: environment.LLM_MAX_OUTPUT_TOKENS,
      maxChunkCharacters: environment.LLM_MAX_CHUNK_CHARS,
      maxChunks: environment.LLM_MAX_CHUNKS,
    },
  );

  await connectDatabase(database);
  const repositories = createRepositories(database);
  const processors = createUnavailableProcessors();
  processors.sourceFetcher = {
    fetch: async (source, signal) => {
      const result = await webExtractor.extract(source.normalizedUrl, signal);
      return {
        ...(result.title === undefined ? {} : { title: result.title }),
        rawContent: result.text,
        contentHash: result.contentHash,
        httpStatus: result.httpStatus,
        ...(result.canonicalUrl === undefined
          ? {}
          : { canonicalUrl: result.canonicalUrl }),
        metadata: result.metadata,
        outboundLinks: result.outboundLinks,
        fetchDurationMs: result.fetchDurationMs,
        fetchMode: result.fetchMode,
        fetchedAt: new Date(),
      };
    },
  };
  processors.contentExtractor = createNormalizedContentProcessor();
  processors.recordProcessor = createHiringSignalRecordProcessor(
    hiringSignalExtractor,
    repositories.researchJobs,
    repositories.extractedRecords,
    metrics,
  );
  const processor = new PipelineJobProcessor(
    repositories.pipeline,
    publisher,
    processors,
    logger,
    metrics,
  );
  await heartbeat.start();
  const runtime = createBullMqWorkers(
    workerRedis,
    processor,
    {
      orchestration: environment.WORKER_ORCHESTRATION_CONCURRENCY,
      sourceFetch: environment.WORKER_SOURCE_FETCH_CONCURRENCY,
      contentExtraction: environment.WORKER_CONTENT_EXTRACTION_CONCURRENCY,
      recordProcessing: environment.WORKER_RECORD_PROCESSING_CONCURRENCY,
    },
    logger,
    {
      stalledIntervalMs: environment.WORKER_STALLED_INTERVAL_MS,
      maxStalledCount: environment.WORKER_MAX_STALLED_COUNT,
      lockDurationMs: environment.WORKER_LOCK_DURATION_MS,
      metrics,
      heartbeat,
    },
  );
  const operationalServer = createWorkerOperationalServer({
    host: environment.WORKER_METRICS_HOST,
    port: environment.WORKER_METRICS_PORT,
    metrics,
    checkDatabase: async () => {
      await database.$queryRaw`SELECT 1`;
      return true;
    },
    checkRedis: () => publisher.checkHealth(),
  });
  await operationalServer.listen();

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    logger.info({ signal }, "Shutting down workers");
    await withTimeout(
      Promise.all([
        runtime.close(),
        webExtractor.close(),
        publisher.close(),
        disconnectDatabase(database),
        operationalServer.close(),
      ]),
      environment.SHUTDOWN_TIMEOUT_MS,
    );
    workerRedis.disconnect();
    logger.info("Workers shut down");
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  const handleFatal = (error: unknown, event: string): void => {
    logger.fatal(
      { err: error, event, errorCode: "PROCESS_FATAL" },
      "Fatal process error",
    );
    void shutdown(event).finally(() => {
      process.exitCode = 1;
    });
  };
  process.once("uncaughtException", (error) =>
    handleFatal(error, "uncaughtException"),
  );
  process.once("unhandledRejection", (error) =>
    handleFatal(error, "unhandledRejection"),
  );
  logger.info("SignalForge workers started");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await startWorker();
}

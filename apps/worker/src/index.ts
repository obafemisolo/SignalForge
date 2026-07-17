import { pathToFileURL } from "node:url";

import { loadEnvironment } from "@signalforge/config";
import {
  connectDatabase,
  createDatabaseClient,
  createRepositories,
  disconnectDatabase,
} from "@signalforge/database";
import { createLogger } from "@signalforge/observability";
import {
  BullMqQueueSystem,
  createWorkerRedisConnection,
} from "@signalforge/queue";

import {
  PipelineJobProcessor,
  createUnavailableProcessors,
} from "./pipeline.js";
import { createBullMqWorkers } from "./runtime.js";

export * from "./pipeline.js";
export * from "./runtime.js";

export async function startWorker(): Promise<void> {
  const environment = loadEnvironment();
  const logger = createLogger({
    level: environment.LOG_LEVEL,
    service: "@signalforge/worker",
  });
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
  });
  const workerRedis = createWorkerRedisConnection(environment.REDIS_URL);

  await connectDatabase(database);
  const repositories = createRepositories(database);
  const processor = new PipelineJobProcessor(
    repositories.pipeline,
    publisher,
    createUnavailableProcessors(),
    logger,
  );
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
  );

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    logger.info({ signal }, "Shutting down workers");
    await runtime.close();
    await publisher.close();
    workerRedis.disconnect();
    await disconnectDatabase(database);
    logger.info("Workers shut down");
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  logger.info("SignalForge workers started");
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await startWorker();
}

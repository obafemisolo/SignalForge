import { pathToFileURL } from "node:url";

import { loadEnvironment } from "@signalforge/config";
import {
  connectDatabase,
  createDatabaseClient,
  createRepositories,
  disconnectDatabase,
} from "@signalforge/database";
import { BullMqResearchOrchestrationQueue } from "@signalforge/queue";
import { createLogger, createMetrics } from "@signalforge/observability";
import { Redis } from "ioredis";

import { buildApi } from "./app.js";
import {
  DatabaseAndQueueReadinessProbe,
  ResearchJobApplicationService,
} from "./service.js";

export { buildApi } from "./app.js";
export * from "./service.js";

export async function startApi(): Promise<void> {
  const environment = loadEnvironment();
  const logger = createLogger({
    level: environment.LOG_LEVEL,
    service: "@signalforge/api",
  });
  const metrics = createMetrics({ service: "@signalforge/api" });
  const database = createDatabaseClient({
    databaseUrl: environment.DATABASE_URL,
  });
  const queue = new BullMqResearchOrchestrationQueue({
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
  const rateLimitRedis = new Redis(environment.REDIS_URL, {
    connectTimeout: 5_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });

  await connectDatabase(database);

  const repositories = createRepositories(database);
  const researchJobs = new ResearchJobApplicationService(
    repositories.researchJobs,
    queue,
    metrics,
  );
  const readiness = new DatabaseAndQueueReadinessProbe(
    async () => {
      await database.$queryRaw`SELECT 1`;
      return true;
    },
    queue,
    environment.READINESS_WORKER_MAX_AGE_MS,
  );
  const app = await buildApi({
    config: {
      bodyLimitBytes: environment.API_BODY_LIMIT_BYTES,
      maxSources: environment.API_MAX_SOURCES,
      jobCreationRateLimitMax: environment.API_JOB_CREATION_RATE_LIMIT_MAX,
      jobCreationRateLimitWindowMs:
        environment.API_JOB_CREATION_RATE_LIMIT_WINDOW_MS,
      nodeEnv: environment.NODE_ENV,
      logLevel: environment.LOG_LEVEL,
    },
    researchJobs,
    readiness,
    metrics,
    queueDepths: () => queue.getQueueDepths(),
    rateLimitRedis,
    logger,
  });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    app.log.info({ signal }, "Shutting down API");
    await withTimeout(
      Promise.all([app.close(), queue.close(), disconnectDatabase(database)]),
      environment.SHUTDOWN_TIMEOUT_MS,
    );
    rateLimitRedis.disconnect();
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

  try {
    await app.listen({
      host: environment.API_HOST,
      port: environment.API_PORT,
    });
  } catch (error) {
    app.log.error({ err: error }, "API startup failed");
    await queue.close();
    rateLimitRedis.disconnect();
    await disconnectDatabase(database);
    throw error;
  }
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
  await startApi();
}

import { pathToFileURL } from "node:url";

import { loadEnvironment } from "@signalforge/config";
import {
  connectDatabase,
  createDatabaseClient,
  createRepositories,
  disconnectDatabase,
} from "@signalforge/database";
import { BullMqResearchOrchestrationQueue } from "@signalforge/queue";
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
  );
  const readiness = new DatabaseAndQueueReadinessProbe(async () => {
    await database.$queryRaw`SELECT 1`;
    return true;
  }, queue);
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
    rateLimitRedis,
  });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    app.log.info({ signal }, "Shutting down API");
    await app.close();
    await queue.close();
    rateLimitRedis.disconnect();
    await disconnectDatabase(database);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

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

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await startApi();
}

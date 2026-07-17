import { randomUUID } from "node:crypto";

import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  EntityNotFoundError,
  PersistenceConflictError,
  PersistenceValidationError,
} from "@signalforge/database";
import {
  apiErrorResponseSchema,
  createResearchJobRequestSchema,
  idempotencyHeadersSchema,
  jobAcceptedDataSchema,
  jobStatusDataSchema,
  paginationSchema,
  researchJobParamsSchema,
  resultItemSchema,
  resultsPaginationQuerySchema,
} from "@signalforge/schemas";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifySchema,
} from "fastify";
import type { Redis } from "ioredis";
import { z, ZodError, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import {
  PublicUrlError,
  assertFound,
  type ReadinessProbe,
  type ResearchJobsApi,
} from "./service.js";

export interface ApiConfiguration {
  bodyLimitBytes: number;
  maxSources: number;
  jobCreationRateLimitMax: number;
  jobCreationRateLimitWindowMs: number;
  nodeEnv: "development" | "test" | "production";
  logLevel: string;
}

export interface BuildApiOptions {
  config: ApiConfiguration;
  researchJobs: ResearchJobsApi;
  readiness: ReadinessProbe;
  logger?: boolean | FastifyBaseLogger;
  rateLimitRedis?: Redis;
}

const defaultConfig: ApiConfiguration = {
  bodyLimitBytes: 1_048_576,
  maxSources: 20,
  jobCreationRateLimitMax: 10,
  jobCreationRateLimitWindowMs: 60_000,
  nodeEnv: "test",
  logLevel: "silent",
};

export async function buildApi(
  options: Omit<BuildApiOptions, "config"> & {
    config?: Partial<ApiConfiguration>;
  },
): Promise<FastifyInstance> {
  const config = { ...defaultConfig, ...options.config };
  const app = Fastify({
    bodyLimit: config.bodyLimitBytes,
    genReqId: () => randomUUID(),
    logger:
      options.logger ??
      (config.nodeEnv === "test"
        ? false
        : {
            level: config.logLevel,
            redact: [
              "req.headers.authorization",
              "req.headers.cookie",
              "req.headers.idempotency-key",
            ],
          }),
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "SignalForge API",
        description:
          "Creates and monitors asynchronous, source-attributed web research jobs.",
        version: "0.1.0",
      },
      tags: [
        { name: "research-jobs", description: "Research job lifecycle" },
        { name: "health", description: "Service health" },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  await app.register(rateLimit, {
    global: false,
    ...(options.rateLimitRedis === undefined
      ? {}
      : { redis: options.rateLimitRedis }),
  });

  app.addHook("onRequest", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });

  registerHealthRoutes(app, options.readiness);
  registerResearchJobRoutes(app, options.researchJobs, config);

  app.setNotFoundHandler(async (request, reply) => {
    reply.status(404).send({
      error: { code: "ROUTE_NOT_FOUND", message: "Route not found" },
      requestId: request.id,
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, "Request failed");

    if (error instanceof ZodError) {
      reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        requestId: request.id,
      });
      return;
    }

    if (error instanceof PublicUrlError) {
      sendError(reply, request.id, 400, "INVALID_SOURCE_URL", error.message);
      return;
    }

    if (error instanceof EntityNotFoundError) {
      sendError(
        reply,
        request.id,
        404,
        "RESEARCH_JOB_NOT_FOUND",
        error.message,
      );
      return;
    }

    if (error instanceof PersistenceConflictError) {
      const code = error.message.includes("Idempotency-Key")
        ? "IDEMPOTENCY_CONFLICT"
        : "NO_FAILED_SOURCES";
      sendError(reply, request.id, 409, code, error.message);
      return;
    }

    if (error instanceof PersistenceValidationError) {
      sendError(reply, request.id, 400, "VALIDATION_ERROR", error.message);
      return;
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "validation" in error &&
      error.validation !== undefined
    ) {
      reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: error.validation,
        },
        requestId: request.id,
      });
      return;
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 429
    ) {
      sendError(
        reply,
        request.id,
        429,
        "RATE_LIMIT_EXCEEDED",
        "Research job creation rate limit exceeded",
      );
      return;
    }

    sendError(
      reply,
      request.id,
      500,
      "INTERNAL_ERROR",
      "An unexpected error occurred",
    );
  });

  await app.ready();
  return app;
}

function registerHealthRoutes(
  app: FastifyInstance,
  readiness: ReadinessProbe,
): void {
  app.get(
    "/health/live",
    {
      schema: {
        tags: ["health"],
        summary: "Liveness probe",
        response: {
          200: openApiSchema(
            z.object({
              data: z.object({ status: z.literal("ok") }),
              requestId: z.string().uuid(),
            }),
          ),
        },
      },
    },
    async (request) => ({
      data: { status: "ok" },
      requestId: request.id,
    }),
  );

  app.get(
    "/health/ready",
    {
      schema: {
        tags: ["health"],
        summary: "Database and Redis readiness probe",
      },
    },
    async (request, reply) => {
      const checks = await readiness.check();
      const ready = checks.database && checks.redis;
      reply.status(ready ? 200 : 503);
      return {
        data: { status: ready ? "ready" : "not_ready", checks },
        requestId: request.id,
      };
    },
  );
}

function registerResearchJobRoutes(
  app: FastifyInstance,
  researchJobs: ResearchJobsApi,
  config: ApiConfiguration,
): void {
  const createRequestSchema = createResearchJobRequestSchema(config.maxSources);

  app.post(
    "/api/v1/research-jobs",
    {
      config: {
        rateLimit: {
          max: config.jobCreationRateLimitMax,
          timeWindow: config.jobCreationRateLimitWindowMs,
        },
      },
      schema: {
        tags: ["research-jobs"],
        summary: "Create an asynchronous research job",
        body: openApiSchema(createRequestSchema),
        headers: openApiSchema(idempotencyHeadersSchema),
        response: {
          202: openApiSchema(
            z.object({
              data: jobAcceptedDataSchema,
              requestId: z.string().uuid(),
            }),
          ),
          400: openApiSchema(apiErrorResponseSchema),
          409: openApiSchema(apiErrorResponseSchema),
          429: openApiSchema(apiErrorResponseSchema),
        },
      },
    },
    async (request, reply) => {
      const body = createRequestSchema.parse(request.body);
      const headers = idempotencyHeadersSchema.parse(request.headers);
      const result = await researchJobs.create(
        body,
        headers["idempotency-key"],
        request.id,
      );

      reply.status(202);
      return { data: result, requestId: request.id };
    },
  );

  app.get(
    "/api/v1/research-jobs/:jobId",
    {
      schema: {
        tags: ["research-jobs"],
        summary: "Get research job status and progress",
        params: openApiSchema(researchJobParamsSchema),
        response: {
          200: openApiSchema(
            z.object({
              data: jobStatusDataSchema,
              requestId: z.string().uuid(),
            }),
          ),
          404: openApiSchema(apiErrorResponseSchema),
        },
      },
    },
    async (request) => {
      const { jobId } = researchJobParamsSchema.parse(request.params);
      const result = assertFound(await researchJobs.getStatus(jobId), jobId);
      return { data: result, requestId: request.id };
    },
  );

  app.get(
    "/api/v1/research-jobs/:jobId/results",
    {
      schema: {
        tags: ["research-jobs"],
        summary: "List validated extracted records",
        params: openApiSchema(researchJobParamsSchema),
        querystring: openApiSchema(resultsPaginationQuerySchema),
        response: {
          200: openApiSchema(
            z.object({
              data: z.object({ records: z.array(resultItemSchema) }),
              meta: paginationSchema,
              requestId: z.string().uuid(),
            }),
          ),
          404: openApiSchema(apiErrorResponseSchema),
        },
      },
    },
    async (request) => {
      const { jobId } = researchJobParamsSchema.parse(request.params);
      const { page, limit } = resultsPaginationQuerySchema.parse(request.query);
      const result = assertFound(
        await researchJobs.getResults(jobId, page, limit),
        jobId,
      );
      return {
        data: { records: result.records },
        meta: result.pagination,
        requestId: request.id,
      };
    },
  );

  app.post(
    "/api/v1/research-jobs/:jobId/retry",
    {
      schema: {
        tags: ["research-jobs"],
        summary: "Retry only failed source documents",
        params: openApiSchema(researchJobParamsSchema),
        response: {
          202: openApiSchema(
            z.object({
              data: z.object({
                id: z.string().uuid(),
                status: z.literal("QUEUED"),
                retriedSources: z.number().int().min(1),
                statusUrl: z.string(),
              }),
              requestId: z.string().uuid(),
            }),
          ),
          404: openApiSchema(apiErrorResponseSchema),
          409: openApiSchema(apiErrorResponseSchema),
        },
      },
    },
    async (request, reply) => {
      const { jobId } = researchJobParamsSchema.parse(request.params);
      const result = await researchJobs.retryFailedSources(jobId, request.id);
      reply.status(202);
      return { data: result, requestId: request.id };
    },
  );
}

function openApiSchema(schema: ZodTypeAny): FastifySchema["body"] {
  return zodToJsonSchema(schema, {
    $refStrategy: "none",
    target: "openApi3",
  }) as FastifySchema["body"];
}

function sendError(
  reply: FastifyReply,
  requestId: string,
  statusCode: number,
  code: string,
  message: string,
): void {
  reply.status(statusCode).send({
    error: { code, message },
    requestId,
  });
}

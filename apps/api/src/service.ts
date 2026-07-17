import { createHash } from "node:crypto";
import { isIP } from "node:net";

import {
  EntityNotFoundError,
  type ResearchJobRepository,
  type ResearchJobStatusView,
  type ResearchResultsPage,
} from "@signalforge/database";
import {
  evidenceItemSchema,
  jsonObjectSchema,
  type JsonObject,
  type ResearchJobRequest,
} from "@signalforge/schemas";
import type { ResearchOrchestrationQueue } from "@signalforge/queue";

export interface AcceptedResearchJob {
  id: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
  createdAt: string;
  statusUrl: string;
}

export interface ResearchJobStatusResponse {
  id: string;
  query: string;
  requestedSources: string[];
  extractionSchema: JsonObject;
  status: AcceptedResearchJob["status"];
  progress: {
    totalSources: number;
    successfulSources: number;
    failedSources: number;
    duplicatesRemoved: number;
  };
  errors: ResearchJobStatusView["errors"];
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResultsResponse {
  records: Array<{
    id: string;
    recordType: string;
    structuredData: JsonObject;
    evidence: ReturnType<typeof evidenceItemSchema.parse>[];
    confidenceScore: number;
    relevanceScore: number;
    source: {
      url: string;
      normalizedUrl: string;
      domain: string;
      title: string | null;
    };
    createdAt: string;
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface RetryResponse {
  id: string;
  status: "QUEUED";
  retriedSources: number;
  statusUrl: string;
}

export interface ResearchJobsApi {
  create(
    input: ResearchJobRequest,
    idempotencyKey: string | undefined,
    requestId: string,
  ): Promise<AcceptedResearchJob>;
  getStatus(id: string): Promise<ResearchJobStatusResponse | null>;
  getResults(
    id: string,
    page: number,
    limit: number,
  ): Promise<ResultsResponse | null>;
  retryFailedSources(id: string, requestId: string): Promise<RetryResponse>;
}

export interface ReadinessProbe {
  check(): Promise<{ database: boolean; redis: boolean }>;
}

export class ResearchJobApplicationService implements ResearchJobsApi {
  public constructor(
    private readonly repository: ResearchJobRepository,
    private readonly queue: ResearchOrchestrationQueue,
  ) {}

  public async create(
    input: ResearchJobRequest,
    idempotencyKey: string | undefined,
    requestId: string,
  ): Promise<AcceptedResearchJob> {
    const normalizedSources = input.sources.map(normalizePublicSourceUrl);
    if (
      new Set(normalizedSources.map((source) => source.normalizedUrl)).size !==
      normalizedSources.length
    ) {
      throw new PublicUrlError(
        "Sources must not contain duplicate normalized URLs",
      );
    }
    const extractionSchema = compileExtractionSchema(
      input.schema.type,
      input.schema.fields,
    );
    const fingerprint = sha256(
      JSON.stringify({
        query: input.query,
        sources: normalizedSources.map((source) => source.normalizedUrl),
        schema: input.schema,
      }),
    );

    const result = await this.repository.createWithSources(
      {
        query: input.query,
        requestedSources: normalizedSources.map((source) => source.sourceUrl),
        extractionSchema,
      },
      normalizedSources,
      idempotencyKey === undefined
        ? undefined
        : {
            idempotencyKeyHash: sha256(idempotencyKey),
            requestFingerprint: fingerprint,
          },
    );

    if (!result.reused || result.job.status === "QUEUED") {
      await this.queue.enqueueResearchJob({
        researchJobId: result.job.id,
        requestedAt: new Date().toISOString(),
        requestId,
      });
    }

    return {
      id: result.job.id,
      status: result.job.status,
      createdAt: result.job.createdAt.toISOString(),
      statusUrl: `/api/v1/research-jobs/${result.job.id}`,
    };
  }

  public async getStatus(
    id: string,
  ): Promise<ResearchJobStatusResponse | null> {
    const view = await this.repository.findStatus(id);

    if (view === null) {
      return null;
    }

    return mapStatusView(view);
  }

  public async getResults(
    id: string,
    page: number,
    limit: number,
  ): Promise<ResultsResponse | null> {
    const result = await this.repository.findResults(id, page, limit);
    return result === null ? null : mapResults(result, page, limit);
  }

  public async retryFailedSources(
    id: string,
    requestId: string,
  ): Promise<RetryResponse> {
    const sourceDocumentIds =
      await this.repository.prepareFailedSourcesForRetry(id);

    await this.queue.enqueueFailedSourceRetry({
      researchJobId: id,
      requestedAt: new Date().toISOString(),
      sourceDocumentIds,
      requestId,
    });

    return {
      id,
      status: "QUEUED",
      retriedSources: sourceDocumentIds.length,
      statusUrl: `/api/v1/research-jobs/${id}`,
    };
  }
}

export function compileExtractionSchema(
  recordType: string,
  fields: readonly string[],
): JsonObject {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: recordType,
    type: "object",
    properties: Object.fromEntries(fields.map((field) => [field, {}])),
    required: [...fields],
    additionalProperties: false,
  };
}

export function normalizePublicSourceUrl(sourceUrl: string) {
  const url = new URL(sourceUrl);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PublicUrlError("Source URL must use the http or https protocol");
  }

  if (url.username !== "" || url.password !== "") {
    throw new PublicUrlError("Source URL must not contain credentials");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (isDisallowedHostname(hostname)) {
    throw new PublicUrlError("Source URL must resolve to a public host");
  }

  url.hash = "";
  url.hostname = hostname;
  url.searchParams.sort();

  return {
    sourceUrl,
    normalizedUrl: url.toString(),
    domain: hostname,
  };
}

export class PublicUrlError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PublicUrlError";
  }
}

export class DatabaseAndQueueReadinessProbe implements ReadinessProbe {
  public constructor(
    private readonly databaseCheck: () => Promise<boolean>,
    private readonly queue: ResearchOrchestrationQueue,
  ) {}

  public async check(): Promise<{ database: boolean; redis: boolean }> {
    const [database, redis] = await Promise.all([
      this.databaseCheck().catch(() => false),
      this.queue.checkHealth(),
    ]);
    return { database, redis };
  }
}

function mapStatusView(view: ResearchJobStatusView): ResearchJobStatusResponse {
  const { job } = view;
  return {
    id: job.id,
    query: job.query,
    requestedSources: job.requestedSources,
    extractionSchema: jsonObjectSchema.parse(job.extractionSchema),
    status: job.status,
    progress: {
      totalSources: job.totalSources,
      successfulSources: job.successfulSources,
      failedSources: job.failedSources,
      duplicatesRemoved: job.duplicatesRemoved,
    },
    errors: view.errors,
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function mapResults(
  result: ResearchResultsPage,
  page: number,
  limit: number,
): ResultsResponse {
  return {
    records: result.records.map((record) => ({
      id: record.id,
      recordType: record.recordType,
      structuredData: jsonObjectSchema.parse(record.structuredData),
      evidence: evidenceItemSchema.array().parse(record.evidence),
      confidenceScore: record.confidenceScore,
      relevanceScore: record.relevanceScore,
      source: {
        url: record.sourceDocument.sourceUrl,
        normalizedUrl: record.sourceDocument.normalizedUrl,
        domain: record.sourceDocument.domain,
        title: record.sourceDocument.title,
      },
      createdAt: record.createdAt.toISOString(),
    })),
    pagination: {
      page,
      limit,
      total: result.total,
      totalPages: result.total === 0 ? 0 : Math.ceil(result.total / limit),
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isDisallowedHostname(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "0.0.0.0"
  ) {
    return true;
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    const [first = 0, second = 0] = hostname
      .split(".")
      .map((part) => Number(part));
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127) ||
      first >= 224
    );
  }

  if (ipVersion === 6) {
    const normalized = hostname.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/u.test(normalized)
    );
  }

  return false;
}

export function assertFound<T>(value: T | null, id: string): T {
  if (value === null) {
    throw new EntityNotFoundError("ResearchJob", id);
  }
  return value;
}

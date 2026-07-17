import { afterEach, describe, expect, it, vi } from "vitest";

import { PersistenceConflictError } from "@signalforge/database";

import { buildApi } from "./app.js";
import type {
  ReadinessProbe,
  ResearchJobStatusResponse,
  ResearchJobsApi,
  ResultsResponse,
} from "./service.js";

const jobId = "3f8b80d7-d42d-4439-826f-cd80b973fb81";
const now = "2026-07-17T17:00:00.000Z";
const validBody = {
  query: "Find Nigerian fintech companies currently hiring backend engineers",
  sources: ["https://example.com/jobs"],
  schema: {
    type: "companyHiringSignal",
    fields: [
      "company",
      "website",
      "role",
      "location",
      "signal",
      "sourceUrl",
      "evidence",
    ],
  },
};

const statusResult: ResearchJobStatusResponse = {
  id: jobId,
  query: validBody.query,
  requestedSources: validBody.sources,
  extractionSchema: { type: "object" },
  status: "QUEUED",
  progress: {
    totalSources: 1,
    successfulSources: 0,
    failedSources: 0,
    duplicatesRemoved: 0,
  },
  errors: { total: 0, items: [] },
  startedAt: null,
  completedAt: null,
  createdAt: now,
  updatedAt: now,
};

const resultsResult: ResultsResponse = {
  records: [],
  pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
};

function fakeResearchJobs(): ResearchJobsApi {
  return {
    create: vi.fn(async () => ({
      id: jobId,
      status: "QUEUED" as const,
      createdAt: now,
      statusUrl: `/api/v1/research-jobs/${jobId}`,
    })),
    getStatus: vi.fn(async () => statusResult),
    getResults: vi.fn(async () => resultsResult),
    retryFailedSources: vi.fn(async () => ({
      id: jobId,
      status: "QUEUED" as const,
      retriedSources: 1,
      statusUrl: `/api/v1/research-jobs/${jobId}`,
    })),
  };
}

const ready: ReadinessProbe = {
  check: vi.fn(async () => ({ database: true, redis: true })),
};

const applications: Awaited<ReturnType<typeof buildApi>>[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

async function makeApp(
  researchJobs: ResearchJobsApi = fakeResearchJobs(),
  readiness: ReadinessProbe = ready,
  config: Parameters<typeof buildApi>[0]["config"] = {},
) {
  const app = await buildApi({
    researchJobs,
    readiness,
    config,
    logger: false,
  });
  applications.push(app);
  return app;
}

describe("research job API", () => {
  it("creates a job asynchronously and forwards the idempotency key", async () => {
    const researchJobs = fakeResearchJobs();
    const app = await makeApp(researchJobs);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/research-jobs",
      headers: { "idempotency-key": "request-123" },
      payload: validBody,
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers["x-request-id"]).toBeTypeOf("string");
    expect(response.json()).toMatchObject({
      data: { id: jobId, status: "QUEUED" },
    });
    expect(researchJobs.create).toHaveBeenCalledWith(
      validBody,
      "request-123",
      expect.any(String),
    );
  });

  it.each([
    [
      "unsupported scheme",
      { ...validBody, sources: ["ftp://example.com/jobs"] },
    ],
    ["empty query", { ...validBody, query: "" }],
    [
      "duplicate fields",
      {
        ...validBody,
        schema: { type: "signal", fields: ["company", "company"] },
      },
    ],
  ])("returns 400 for %s", async (_name, payload) => {
    const app = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/research-jobs",
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("enforces the configured source limit", async () => {
    const app = await makeApp(fakeResearchJobs(), ready, { maxSources: 1 });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/research-jobs",
      payload: {
        ...validBody,
        sources: ["https://example.com/one", "https://example.org/two"],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects an invalid Idempotency-Key header", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/research-jobs",
      headers: { "idempotency-key": "contains spaces" },
      payload: validBody,
    });

    expect(response.statusCode).toBe(400);
  });

  it("rate limits job creation", async () => {
    const app = await makeApp(fakeResearchJobs(), ready, {
      jobCreationRateLimitMax: 1,
      jobCreationRateLimitWindowMs: 60_000,
    });

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/research-jobs",
      payload: validBody,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/research-jobs",
      payload: validBody,
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({
      error: { code: "RATE_LIMIT_EXCEEDED" },
    });
  });

  it("returns job progress and validates UUID parameters", async () => {
    const app = await makeApp();
    const valid = await app.inject({
      method: "GET",
      url: `/api/v1/research-jobs/${jobId}`,
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/api/v1/research-jobs/not-a-uuid",
    });

    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({
      data: { id: jobId, progress: { totalSources: 1 } },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("returns paginated results and rejects invalid pagination", async () => {
    const researchJobs = fakeResearchJobs();
    const app = await makeApp(researchJobs);
    const valid = await app.inject({
      method: "GET",
      url: `/api/v1/research-jobs/${jobId}/results?page=1&limit=20`,
    });
    const invalid = await app.inject({
      method: "GET",
      url: `/api/v1/research-jobs/${jobId}/results?page=0`,
    });

    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({
      data: { records: [] },
      meta: { total: 0, totalPages: 0 },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("queues a failed-source retry", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/research-jobs/${jobId}/retry`,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      data: { id: jobId, status: "QUEUED", retriedSources: 1 },
    });
  });

  it("returns 409 when there are no failed sources to retry", async () => {
    const researchJobs = fakeResearchJobs();
    researchJobs.retryFailedSources = vi.fn(async () => {
      throw new PersistenceConflictError(
        "The research job has no failed sources to retry",
      );
    });
    const app = await makeApp(researchJobs);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/research-jobs/${jobId}/retry`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "NO_FAILED_SOURCES" },
    });
  });

  it("returns a consistent 404 response", async () => {
    const researchJobs = fakeResearchJobs();
    researchJobs.getStatus = vi.fn(async () => null);
    const app = await makeApp(researchJobs);
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/research-jobs/${jobId}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "RESEARCH_JOB_NOT_FOUND" },
      requestId: expect.any(String),
    });
  });

  it("does not expose stack traces for unexpected production errors", async () => {
    const researchJobs = fakeResearchJobs();
    researchJobs.getStatus = vi.fn(async () => {
      throw new Error("database password should not leak");
    });
    const app = await makeApp(researchJobs, ready, { nodeEnv: "production" });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/research-jobs/${jobId}`,
    });
    const body = response.json();

    expect(response.statusCode).toBe(500);
    expect(body).toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      },
    });
    expect(JSON.stringify(body)).not.toContain("password");
    expect(body.error).not.toHaveProperty("stack");
  });
});

describe("health and documentation", () => {
  it("reports liveness and readiness", async () => {
    const app = await makeApp();
    const live = await app.inject({ method: "GET", url: "/health/live" });
    const readiness = await app.inject({ method: "GET", url: "/health/ready" });

    expect(live.statusCode).toBe(200);
    expect(readiness.statusCode).toBe(200);
  });

  it("returns 503 when a readiness dependency is unavailable", async () => {
    const app = await makeApp(fakeResearchJobs(), {
      check: vi.fn(async () => ({ database: true, redis: false })),
    });
    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(503);
  });

  it("publishes OpenAPI documentation for every required route", async () => {
    const app = await makeApp();
    const document = app.swagger();

    expect(Object.keys(document.paths ?? {})).toEqual(
      expect.arrayContaining([
        "/api/v1/research-jobs",
        "/api/v1/research-jobs/{jobId}",
        "/api/v1/research-jobs/{jobId}/results",
        "/api/v1/research-jobs/{jobId}/retry",
        "/health/live",
        "/health/ready",
      ]),
    );
    expect(
      await app.inject({ method: "GET", url: "/docs/json" }),
    ).toMatchObject({ statusCode: 200 });
  });
});

import { describe, expect, it } from "vitest";

import { EnvironmentValidationError, loadEnvironment } from "./index.js";

describe("loadEnvironment", () => {
  it("parses required values and applies safe defaults", () => {
    const environment = loadEnvironment({
      DATABASE_URL: "postgresql://signalforge:password@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
    });

    expect(environment).toEqual({
      NODE_ENV: "development",
      API_HOST: "0.0.0.0",
      API_PORT: 3000,
      API_BODY_LIMIT_BYTES: 1_048_576,
      API_MAX_SOURCES: 20,
      API_JOB_CREATION_RATE_LIMIT_MAX: 10,
      API_JOB_CREATION_RATE_LIMIT_WINDOW_MS: 60_000,
      WORKER_ORCHESTRATION_CONCURRENCY: 2,
      WORKER_SOURCE_FETCH_CONCURRENCY: 5,
      WORKER_CONTENT_EXTRACTION_CONCURRENCY: 4,
      WORKER_RECORD_PROCESSING_CONCURRENCY: 4,
      QUEUE_ORCHESTRATION_TIMEOUT_MS: 30_000,
      QUEUE_SOURCE_FETCH_TIMEOUT_MS: 30_000,
      QUEUE_CONTENT_EXTRACTION_TIMEOUT_MS: 60_000,
      QUEUE_RECORD_PROCESSING_TIMEOUT_MS: 90_000,
      EXTRACTION_MAX_BODY_BYTES: 2_000_000,
      EXTRACTION_MAX_REDIRECTS: 5,
      EXTRACTION_CONNECTION_TIMEOUT_MS: 10_000,
      EXTRACTION_TOTAL_TIMEOUT_MS: 30_000,
      EXTRACTION_GLOBAL_CONCURRENCY: 10,
      EXTRACTION_DOMAIN_CONCURRENCY: 2,
      EXTRACTION_DOMAIN_DELAY_MS: 500,
      EXTRACTION_MIN_CONTENT_CHARS: 200,
      EXTRACTION_PLAYWRIGHT_ENABLED: true,
      EXTRACTION_USER_AGENT:
        "SignalForgeBot/0.1 (controlled public web research; respects robots.txt)",
      LOG_LEVEL: "info",
      DATABASE_URL: "postgresql://signalforge:password@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
    });
  });

  it("rejects invalid external configuration without exposing values", () => {
    const invalidDatabaseUrl = "https://not-a-database.example";

    expect(() =>
      loadEnvironment({
        DATABASE_URL: invalidDatabaseUrl,
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toThrow(EnvironmentValidationError);

    try {
      loadEnvironment({
        DATABASE_URL: invalidDatabaseUrl,
        REDIS_URL: "redis://localhost:6379",
      });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect((error as Error).message).toContain("DATABASE_URL");
      expect((error as Error).message).not.toContain(invalidDatabaseUrl);
    }
  });
});

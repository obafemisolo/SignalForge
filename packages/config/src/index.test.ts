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

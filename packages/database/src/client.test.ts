import { describe, expect, it } from "vitest";

import { createDatabaseClient, disconnectDatabase } from "./client.js";
import { DatabaseConfigurationError } from "./errors.js";

describe("database client lifecycle", () => {
  it("rejects an empty database URL before creating a pool", () => {
    expect(() => createDatabaseClient({ databaseUrl: " " })).toThrow(
      DatabaseConfigurationError,
    );
  });

  it("rejects a non-PostgreSQL connection URL", () => {
    expect(() =>
      createDatabaseClient({ databaseUrl: "https://database.example" }),
    ).toThrow(DatabaseConfigurationError);
  });

  it("can dispose a client before its first query", async () => {
    const client = createDatabaseClient({
      databaseUrl: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
      connectionTimeoutMs: 10,
      maxConnections: 1,
    });

    await expect(disconnectDatabase(client)).resolves.toBeUndefined();
  });
});

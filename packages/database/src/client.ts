import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";
import { DatabaseConfigurationError } from "./errors.js";

export interface DatabaseClientOptions {
  databaseUrl: string;
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxConnections?: number;
}

let sharedClient: PrismaClient | undefined;

export function createDatabaseClient(
  options: DatabaseClientOptions,
): PrismaClient {
  if (options.databaseUrl.trim().length === 0) {
    throw new DatabaseConfigurationError(
      "A non-empty database URL is required",
    );
  }

  let protocol: string;

  try {
    protocol = new URL(options.databaseUrl).protocol;
  } catch {
    throw new DatabaseConfigurationError(
      "The database URL must be a valid PostgreSQL URL",
    );
  }

  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new DatabaseConfigurationError(
      "The database URL must use the postgres or postgresql protocol",
    );
  }

  const adapter = new PrismaPg({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    max: options.maxConnections ?? 10,
  });

  return new PrismaClient({ adapter });
}

export function getDatabaseClient(
  options?: DatabaseClientOptions,
): PrismaClient {
  if (sharedClient !== undefined) {
    return sharedClient;
  }

  const databaseUrl = options?.databaseUrl ?? process.env.DATABASE_URL;

  if (databaseUrl === undefined) {
    throw new DatabaseConfigurationError(
      "DATABASE_URL is required to create the shared database client",
    );
  }

  sharedClient = createDatabaseClient({ ...options, databaseUrl });

  return sharedClient;
}

export async function connectDatabase(
  client: PrismaClient = getDatabaseClient(),
): Promise<PrismaClient> {
  await client.$connect();
  return client;
}

export async function disconnectDatabase(
  client: PrismaClient | undefined = sharedClient,
): Promise<void> {
  if (client === undefined) {
    return;
  }

  await client.$disconnect();

  if (client === sharedClient) {
    sharedClient = undefined;
  }
}

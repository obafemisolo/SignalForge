import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { defineConfig } from "prisma/config";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));

loadDotenv({
  path: resolve(packageDirectory, "../../.env"),
  quiet: true,
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (testDatabaseUrl === undefined || testDatabaseUrl.length === 0) {
  throw new Error("TEST_DATABASE_URL is required for test migrations");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: testDatabaseUrl,
  },
});

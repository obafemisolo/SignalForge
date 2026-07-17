import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { defineConfig } from "prisma/config";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));

loadDotenv({
  path: resolve(packageDirectory, "../../.env"),
  quiet: true,
});

const localDevelopmentUrl =
  "postgresql://signalforge:signalforge_dev@localhost:5432/signalforge";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? localDevelopmentUrl,
  },
});

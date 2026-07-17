import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { defineConfig } from "vitest/config";

loadDotenv({ quiet: true });

export default defineConfig({
  resolve: {
    alias: {
      "@signalforge/database": fileURLToPath(
        new URL("./packages/database/src/index.ts", import.meta.url),
      ),
      "@signalforge/config": fileURLToPath(
        new URL("./packages/config/src/index.ts", import.meta.url),
      ),
      "@signalforge/queue": fileURLToPath(
        new URL("./packages/queue/src/index.ts", import.meta.url),
      ),
      "@signalforge/schemas": fileURLToPath(
        new URL("./packages/schemas/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: [
      "apps/**/*.test.ts",
      "packages/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    passWithNoTests: false,
  },
});

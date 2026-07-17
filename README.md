# SignalForge

SignalForge is an open-source, production-minded AI web-research pipeline. It
will accept a natural-language research request, gather content from explicitly
permitted public web sources, extract readable content, convert it into
schema-validated records, remove duplicates, score the results, and preserve
source attribution and supporting evidence.

This repository currently contains the monorepo foundation and Phase 2
PostgreSQL persistence layer. Research orchestration, web extraction,
queue-processing, and LLM provider logic are intentionally not implemented yet.

## Architecture

The repository is a pnpm workspace split into deployable applications and
focused shared packages:

```text
apps/
  api/              Fastify HTTP API
  worker/           BullMQ background workers
packages/
  config/           Validated environment configuration
  database/         Prisma schema and PostgreSQL client
  extraction/       Controlled web fetching and content normalization
  llm/              Provider-independent LLM extraction
  observability/    Logging, metrics, and tracing helpers
  queue/            BullMQ queues and shared job contracts
  schemas/          Shared Zod schemas and TypeScript types
tests/              Cross-package and integration tests
```

PostgreSQL will store durable research state and results. Redis will support
BullMQ jobs and distributed coordination. The API and worker remain separate
processes so HTTP traffic and background extraction can scale independently.

## Prerequisites

- Node.js 22
- pnpm 10 (Corepack is recommended)
- Docker with Docker Compose

Enable the repository's pinned pnpm version:

```bash
corepack enable
corepack prepare pnpm@10.12.1 --activate
```

## Local setup

1. Create a local environment file:

   ```bash
   cp .env.example .env
   ```

2. Install workspace dependencies:

   ```bash
   pnpm install
   ```

3. Start PostgreSQL, the isolated test database, and Redis:

   ```bash
   docker compose --profile test up -d
   ```

4. Apply the development migration and seed one sample research job:

   ```bash
   pnpm db:migrate:deploy
   pnpm db:seed
   ```

5. Verify the workspace:

   ```bash
   pnpm format:check
   pnpm lint
   pnpm typecheck
   pnpm db:migrate:test
   pnpm test
   pnpm build
   docker compose config --quiet
   ```

6. Start application development watchers:

   ```bash
   pnpm dev
   ```

The credentials in `.env.example` and `docker-compose.yml` are public,
local-development defaults only. Replace them in deployed environments and never
commit a populated `.env` file.

## Database

The Prisma schema and migrations live under `packages/database/prisma`.
SignalForge uses UUID primary keys, PostgreSQL enums, JSONB for extraction
schemas and structured records, and foreign keys with cascading cleanup. The
repository layer in `packages/database/src/repositories` is the application
boundary for persistence.

Use these commands for database development:

- `pnpm db:generate` regenerates the Prisma client.
- `pnpm db:migrate` creates and applies a development migration.
- `pnpm db:migrate:deploy` applies committed migrations to the development
  database.
- `pnpm db:migrate:test` applies committed migrations to `TEST_DATABASE_URL`.
- `pnpm db:seed` idempotently inserts the sample research job.
- `pnpm test:integration` migrates the test database and runs repository
  integration tests.

Do not point `TEST_DATABASE_URL` at a development or production database. The
integration suite deletes research jobs between scenarios.

## Workspace commands

- `pnpm dev` starts app development watchers.
- `pnpm build` builds every workspace package.
- `pnpm lint` checks the repository with ESLint.
- `pnpm format` formats supported files with Prettier.
- `pnpm format:check` checks formatting without modifying files.
- `pnpm typecheck` runs strict TypeScript validation.
- `pnpm test` runs the Vitest suite.

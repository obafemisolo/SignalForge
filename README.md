# SignalForge

SignalForge is an open-source, production-minded AI web-research pipeline. It
will accept a natural-language research request, gather content from explicitly
permitted public web sources, extract readable content, convert it into
schema-validated records, remove duplicates, score the results, and preserve
source attribution and supporting evidence.

This repository currently contains the monorepo foundation, PostgreSQL
persistence layer, asynchronous research-job API, and Phase 4 BullMQ worker
pipeline. Controlled web extraction and LLM-backed record extraction remain
intentionally unimplemented.

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

6. Start the API and worker in separate terminals:

   ```bash
   pnpm --filter @signalforge/api dev
   ```

   ```bash
   pnpm --filter @signalforge/worker dev
   ```

The API listens on `http://localhost:3000` by default. Interactive OpenAPI
documentation is available at `http://localhost:3000/docs`, with the generated
document at `/docs/json`.

Use `pnpm dev` when both application watchers should run together.

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

The Phase 3 migration adds a unique SHA-256 hash of the client-provided
`Idempotency-Key` and a request fingerprint. Raw idempotency keys are never
stored. Apply it with `pnpm db:migrate:deploy` before starting the API.

## Research job API

`POST /api/v1/research-jobs` persists a job and its source placeholders, then
enqueues a BullMQ orchestration message. The API does not fetch pages or invoke
an LLM. A repeated request with the same `Idempotency-Key` and payload returns
the existing job; reusing that key for a different payload returns HTTP 409.

The lifecycle endpoints are:

- `POST /api/v1/research-jobs`
- `GET /api/v1/research-jobs/:jobId`
- `GET /api/v1/research-jobs/:jobId/results?page=1&limit=20`
- `POST /api/v1/research-jobs/:jobId/retry`
- `GET /health/live`
- `GET /health/ready`

Creation requests are Zod-validated, source URLs are limited to public HTTP(S)
targets, and lexical localhost/private-address checks are applied before
persistence. The extraction worker must also resolve DNS and revalidate every
redirect destination immediately before connecting; API validation alone cannot
prevent DNS rebinding.

Job creation is rate-limited through Redis in the running API process. The
injected test application uses the plugin's in-memory store so Fastify injection
tests do not need Redis.

## Background worker pipeline

The worker application is a separately deployable process. It uses five BullMQ
queues:

1. `research-orchestration`
2. `source-fetch`
3. `content-extraction`
4. `record-processing`
5. `dead-letter`

Orchestration loads the persisted research job and creates one source-fetch job
per source document. Each successful stage persists its transition before
publishing the next deterministic job. Source job IDs include the persisted
pipeline attempt number, preventing duplicate processing after restarts while
allowing an explicit failed-source retry to begin a new generation.

Jobs use bounded attempts, exponential backoff, and stage-specific timeouts.
Worker concurrency and timeouts are configured through the
`WORKER_*_CONCURRENCY` and `QUEUE_*_TIMEOUT_MS` variables in `.env.example`.
`SIGINT` and `SIGTERM` stop intake and wait for active BullMQ jobs before Redis
and PostgreSQL connections are closed.

Permanent failures are written to `dead-letter` with the originating queue, job
ID, research job ID, source ID, pipeline attempt, attempt count, and error
context. One source failure updates only that source. Research-job progress is
recalculated under a PostgreSQL row lock and becomes `COMPLETED`, `PARTIAL`, or
`FAILED` only after every source has a terminal outcome.

Phase 4 intentionally installs unavailable source-fetch, content-extraction, and
record-processing adapters in the executable worker. They fail explicitly
instead of fabricating results. Later phases replace those adapters with the
controlled extractor and validated LLM processor without changing queue or
persistence contracts.

## Workspace commands

- `pnpm dev` starts app development watchers.
- `pnpm build` builds every workspace package.
- `pnpm lint` checks the repository with ESLint.
- `pnpm format` formats supported files with Prettier.
- `pnpm format:check` checks formatting without modifying files.
- `pnpm typecheck` runs strict TypeScript validation.
- `pnpm test` runs the Vitest suite.

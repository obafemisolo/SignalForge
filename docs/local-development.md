# Local development

This guide takes a new contributor from a fresh clone to a working SignalForge
development environment.

## Prerequisites

| Tool           | Supported version | Check                    |
| -------------- | ----------------- | ------------------------ |
| Node.js        | 22.x              | `node --version`         |
| pnpm           | 10.x              | `pnpm --version`         |
| Docker Compose | Current v2        | `docker compose version` |
| Git            | Current           | `git --version`          |

Playwright Chromium is optional for most unit-test work but required to exercise
the browser-rendering fallback.

## Install

```bash
git clone <your-fork-or-repository-url>
cd SignalForge
corepack enable
corepack prepare pnpm@10.12.1 --activate
cp .env.example .env
pnpm install --frozen-lockfile
```

PowerShell equivalent:

```powershell
Copy-Item .env.example .env
```

Never commit `.env`. The checked-in `.env.example` is the documented template.

## Configure

The development defaults already target local PostgreSQL and Redis:

```dotenv
DATABASE_URL=postgresql://signalforge:signalforge_dev@localhost:5432/signalforge
REDIS_URL=redis://localhost:6379
SIGNALFORGE_API_URL=http://localhost:3000
```

For live research jobs using the default provider, set:

```dotenv
LLM_API_KEY=your-key-here
LLM_MODEL=gpt-4.1-mini
```

Tests use controlled fakes and do not require a provider key. For a compatible
self-hosted provider, update `LLM_BASE_URL`, `LLM_MODEL`, and the key behavior
expected by that provider.

See [environment.md](environment.md) for production configuration guidance.

## Start infrastructure

Start only the dependencies needed by local Node processes:

```bash
docker compose up -d postgres redis
docker compose ps
```

Apply committed migrations and seed the sample job:

```bash
pnpm db:migrate:deploy
pnpm db:seed
```

Install Playwright Chromium when working on live extraction:

```bash
pnpm --filter @signalforge/extraction exec playwright install chromium
```

On Linux CI or a fresh Linux machine, Playwright may need system dependencies:

```bash
pnpm --filter @signalforge/extraction exec playwright install --with-deps chromium
```

## Start SignalForge

The simplest option is:

```bash
pnpm dev
```

This runs all three applications in watch mode:

| Process | Address                            | Entrypoint                 |
| ------- | ---------------------------------- | -------------------------- |
| API     | `http://localhost:3000`            | `apps/api/src/index.ts`    |
| Web     | `http://localhost:3001`            | `apps/web/app/page.tsx`    |
| Worker  | `http://localhost:9464` for health | `apps/worker/src/index.ts` |

Run processes separately when you want cleaner logs:

```bash
# terminal 1
pnpm --filter @signalforge/api dev

# terminal 2
pnpm --filter @signalforge/worker dev

# terminal 3
pnpm --filter @signalforge/web dev
```

Open:

- web interface: `http://localhost:3001`
- OpenAPI: `http://localhost:3000/docs`
- API readiness: `http://localhost:3000/health/ready`
- API metrics: `http://localhost:3000/metrics`
- worker readiness: `http://localhost:9464/health/ready`
- worker metrics: `http://localhost:9464/metrics`

## Run with Docker only

Build and start the application stack:

```bash
docker compose --profile migrate run --rm migrate
docker compose up --build
```

The web interface is exposed at `http://localhost:3001`. Add observability:

```bash
docker compose --profile observability up --build
```

Prometheus is exposed at `http://localhost:9090` and Grafana at
`http://localhost:3002`.

## Test

Unit and workspace tests:

```bash
pnpm test
```

A focused test file:

```bash
pnpm vitest run packages/record-processing/src/record-processing.test.ts
```

Database integration tests use isolated ports and a separate database:

```bash
docker compose --profile test up -d postgres-test redis-test
pnpm test:integration
```

The integration configuration uses:

- PostgreSQL: `localhost:5433/signalforge_test`
- Redis: `localhost:6380`

Never point `TEST_DATABASE_URL` at your development or production database.

## Validate a contribution

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

These are the main local equivalents of CI. Database and queue changes should
also run `pnpm test:integration`.

## Change the database

After editing `packages/database/prisma/schema.prisma`, create a development
migration:

```bash
pnpm db:migrate
```

Give the migration a descriptive name, inspect the SQL under
`packages/database/prisma/migrations`, and include repository tests. Do not edit
an existing committed migration that may already have been applied.

## Useful Docker commands

```bash
docker compose ps
docker compose logs -f api worker
docker compose stop
docker compose down
```

`docker compose down -v` removes local database and Redis volumes. Use it only
when you intentionally want to delete local state.

## Troubleshooting

### `pnpm` or Node is not the expected version

The repository requires Node 22 and pnpm 10:

```bash
node --version
pnpm --version
corepack prepare pnpm@10.12.1 --activate
```

If you use a Node version manager, the repository’s `.nvmrc` selects Node 22.

### Port already in use

The default ports are API `3000`, web `3001`, Grafana `3002`, PostgreSQL `5432`,
Redis `6379`, worker metrics `9464`, and Prometheus `9090`. Stop the conflicting
process or update the matching environment and launch configuration.

### API is ready but jobs do not progress

Check:

1. the worker process is running;
2. Redis and PostgreSQL are healthy;
3. `LLM_API_KEY` is set for the default OpenAI endpoint;
4. `http://localhost:9464/health/ready`;
5. worker logs for the source-stage error code.

### Playwright browser is missing

```bash
pnpm --filter @signalforge/extraction exec playwright install chromium
```

You can temporarily set `EXTRACTION_PLAYWRIGHT_ENABLED=false` when your work
does not require browser-rendered pages.

### WSL cannot find the Windows Node installation

Install Node inside the WSL distribution or run pnpm from PowerShell/Command
Prompt. Avoid mixing a Windows pnpm shim with a WSL shell where `node` is not on
the Linux `PATH`.

### Reset only the test services

```bash
docker compose --profile test stop postgres-test redis-test
docker compose --profile test rm -f postgres-test redis-test
docker compose --profile test up -d postgres-test redis-test
```

For runtime incidents rather than local setup, use the
[operations runbook](runbook.md).

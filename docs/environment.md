# Environment configuration

SignalForge validates environment variables at process startup. The complete
development template is [`.env.example`](../.env.example). Keep one secret store
and one parameter set per environment.

## Development

Copy `.env.example` to `.env`, use the local PostgreSQL/Redis ports, and run
`docker compose --profile test up -d` when integration tests are needed. The
default credentials are for local development only.

## Staging

Use isolated database and Redis endpoints, a staging LLM key, conservative
worker concurrency, and a short log retention period. Deploy migrations before
starting application tasks. Set `NODE_ENV=staging` only if a future config
schema adds it; the current validated runtime modes are `development`, `test`,
and `production`, so staging should use the production-safe behavior with
staging-specific resources.

## Production

Inject `DATABASE_URL`, `REDIS_URL`, and `LLM_API_KEY` from AWS Secrets Manager
or SSM Parameter Store. Set `NODE_ENV=production`, disable Playwright unless
needed, use bounded concurrency, and configure `LOG_LEVEL=info` or `warn`.
Expose only the ALB and required metrics path; keep worker metrics private.
Rotate secrets without rebuilding images and monitor LLM usage/cost metrics.

## Docker Compose profiles

The default Compose stack starts PostgreSQL, Redis, API, worker, and web. Add
`--profile observability` to include Prometheus and Grafana. Add
`--profile test` to start isolated PostgreSQL and Redis test services. Use
`--profile migrate run --rm migrate` to apply committed migrations before the
API and worker are started.

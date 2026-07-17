# SignalForge operations runbook

This runbook assumes the API, worker, PostgreSQL, and Redis are deployed as
separate processes. Start with `/health/live` for process liveness,
`/health/ready` for API dependency readiness, and `/metrics` for counters and
queue depth. The worker exposes the same three paths on `WORKER_METRICS_PORT`
(default `9464`).

## PostgreSQL unavailable

Symptoms include `signalforge` readiness reporting `database=false`, API 5xx
responses, or rising queue retries. Check the database container/service,
network policy, connection saturation, and `DATABASE_URL` without printing the
value. Restore connectivity, then confirm `SELECT 1` succeeds and rerun
`/health/ready`. BullMQ jobs remain durable in Redis; do not manually replay
jobs unless the queue has lost its data.

## Redis unavailable

Symptoms include `redis=false`, failed job creation, queue depth becoming stale,
or worker connection errors. Check Redis health, memory/eviction policy, network
access, and credentials. Restore Redis before restarting workers. If the
dead-letter queue is growing, preserve it until the underlying failure is
understood.

## Increasing dead-letter queue

Inspect `signalforge_queue_depth{queue_name="dead-letter"}` and the structured
dead-letter payloads. Group failures by `errorCode`, source domain, and queue.
Fix the common cause first, then replay only reviewed jobs with deterministic
job IDs. Never bulk replay a source that is blocked by robots, authentication,
or an SSRF policy.

## LLM provider outage

Look at `signalforge_llm_requests_total`, request latency, retry counts, and the
provider error code. Confirm the configured endpoint and model, then lower
record-processing concurrency if the provider is rate limiting. Failed source
jobs are isolated from other research jobs; wait for recovery or use the
configured provider fallback before replaying dead-letter items.

## Repeated source timeouts

Inspect `signalforge_fetch_total`, queue duration, domain, HTTP status, and
`errorCode`. Check whether one domain is slow or all domains are affected.
Increase timeouts only after checking response size, robots policy, and domain
rate limits. Keep redirect and body limits unchanged unless there is a reviewed
capacity decision.

## High queue depth

Compare waiting, active, delayed, and failed gauges for each queue. Check worker
heartbeat freshness and worker CPU/memory. Increase bounded worker concurrency
gradually, respecting per-domain extraction limits and LLM provider quotas.
Persistent depth with no heartbeat indicates a worker deployment or Redis
connectivity problem.

## Cost spikes

Use `signalforge_llm_tokens_total` and
`signalforge_llm_estimated_cost_usd_total`, grouped by model and provider. Check
query volume, chunk counts, repair rates, and duplicate source submissions.
Temporarily lower `LLM_MAX_CHUNKS` or concurrency if needed, but do not disable
schema validation or evidence checks to reduce cost.

## Shutdown and recovery

Send SIGTERM and allow the configured `SHUTDOWN_TIMEOUT_MS` for active jobs to
finish. Workers stop accepting new work, close queue consumers, remove their
heartbeat member, and close database/Redis resources. Stalled jobs are
automatically recovered by BullMQ and counted as retries; inspect them before
changing `WORKER_MAX_STALLED_COUNT`.

# SignalForge focused security review

Review scope: the repository as of this release, including the Fastify API,
BullMQ worker, extraction and LLM packages, persistence boundary, web export,
Compose files, and CI configuration. This is a focused engineering review, not a
penetration test or a claim that SignalForge is fully secure.

## Findings fixed in this review

### High — spreadsheet formula injection in CSV export

**Exploit path:** A source page or validated record can contain a value
beginning with `=`, `+`, `-`, or `@`. A user downloads the results CSV and opens
it in a spreadsheet, which may interpret the value as a formula and execute a
command or load a remote resource.

**Affected files:** `apps/web/app/research-jobs/[jobId]/helpers.ts` and its
test.

**Fix:** Prefix formula-like values with an apostrophe before quoting CSV
fields. Regression coverage verifies all four formula prefixes.

### High — unvalidated Redis job payloads at the worker boundary

**Exploit path:** Any principal able to write to the BullMQ Redis instance could
insert a job whose payload is not the TypeScript shape assumed by the worker.
That could trigger unexpected database lookups, oversized arrays, malformed
identifiers, or poisoned downstream work.

**Affected files:** `apps/worker/src/runtime.ts`,
`packages/queue/src/contracts.ts`.

**Fix:** Worker handlers now parse job names and payloads with the shared Zod
schemas before invoking pipeline code. Invalid jobs fail as unrecoverable, and
retry source IDs are bounded to 100. Regression tests cover malformed payloads
and the source-ID bound.

### Medium — oversized response streams were not explicitly destroyed

**Exploit path:** A server can omit or falsify `Content-Length` and stream a
large body. SignalForge stops accumulating after the configured limit, but the
underlying response stream was not explicitly destroyed at that point, allowing
unnecessary socket and upstream work.

**Affected files:** `packages/extraction/src/http-client.ts`.

**Fix:** The transport response is discarded whenever bounded body reading
fails. A regression test verifies `discard()` is called for an oversized body.

### Medium — local Compose services were exposed on all interfaces

**Exploit path:** A developer running Compose on a laptop could expose database,
Redis, worker metrics, Grafana, or application ports to the local network. The
development credentials are intentionally public defaults, so network exposure
increases the chance of unauthorized access.

**Affected file:** `docker-compose.yml`.

**Fix:** Host bindings now use `127.0.0.1`. Production deployments must use
private subnets and security groups as described in `docs/deployment.md`.

### Medium — unbounded per-domain limiter state could be used for memory growth

**Exploit path:** A stream of jobs containing many distinct hostnames could
create one in-memory semaphore per hostname and retain it for the worker process
lifetime, even though global request concurrency was bounded.

**Affected files:** `packages/extraction/src/limiter.ts` and
`packages/extraction/src/robots.ts`.

**Fix:** The limiter now caps tracked domains at 1,024, evicts the least-recent
idle state, and refuses a new domain while all tracked states are active. The
robots cache uses the same bounded eviction approach. Regression tests cover
both limiter refusal/eviction and robots-cache eviction.

## Reviewed controls with no new code change required

- **SSRF and unsafe redirects:** submitted URLs accept only HTTP(S), reject URL
  credentials, enforce length limits, resolve DNS, reject private/link-local/
  metadata ranges, pin the resolved address in the Node transport, and repeat
  validation for every redirect. Redirects are bounded and Playwright is only
  used with already-fetched HTML while all browser routes are aborted.
- **DNS rebinding:** the HTTP transport uses the validated address through a
  custom lookup function. Redirect destinations are re-resolved before use.
  Browser rendering does not navigate to the source; it renders a string.
- **Command injection:** application code does not use shell execution or
  interpolate user input into commands. CI Docker commands use fixed paths.
- **Prompt injection:** webpage text is delimited as untrusted data, system
  instructions forbid instruction-following, outputs require exact source URLs
  and evidence, and Zod plus mention/evidence checks reject unsupported claims.
- **SQL injection:** raw SQL is limited to parameterized Prisma tagged queries
  for row locks. No `$queryRawUnsafe` call exists in application code.
- **Input validation:** API params, query strings, bodies, idempotency headers,
  queue payloads, LLM output, persistence input, and environment configuration
  use runtime schemas. API and extraction body/URL/source/chunk limits are
  bounded.
- **Sensitive logging:** Pino redacts authorization, cookies, passwords, tokens,
  API keys, and database/Redis URLs. API request logs do not include request
  bodies or source text. LLM provider errors avoid returning response bodies.
- **Queue abuse and duplicates:** queue contracts use deterministic IDs, bounded
  retries/backoff/retention, and bounded concurrency. API creation is rate
  limited and idempotency fingerprints prevent key reuse with a different
  payload.
- **Error responses:** production API errors return stable codes and generic
  messages without stack traces. Detailed failures remain in controlled
  persistence/log paths.
- **Docker posture:** production images are multi-stage and run as the `node`
  user. Secrets are environment-injected and not copied into image layers.

## Residual risks and limitations

### High — no authentication or authorization

The MVP intentionally has no user identity. Anyone who can reach the API and
guess a UUID can read job status/results or retry failed sources. UUIDs are not
an authorization mechanism. Put the API behind an authenticated gateway or add
tenant-aware authorization before exposing it to untrusted users.

### High — infrastructure trust is assumed for Redis and PostgreSQL

Queue payload validation reduces poisoning impact but does not replace Redis
authentication, TLS, network isolation, or least-privilege credentials. A
compromised Redis principal can still enqueue valid but unwanted work.

### Medium — rate limiting behind proxies needs deployment verification

Fastify's request IP behavior must be configured consistently with the ALB or
reverse proxy. If proxy headers are trusted incorrectly, clients may spoof the
rate-limit key; if they are not trusted, all clients may share one bucket.
Verify this in the production ingress configuration.

### Medium — configurable LLM endpoints are trusted configuration

`LLM_BASE_URL` is environment-controlled, not request-controlled. A compromised
deployment environment could redirect prompts and the API key to an attacker.
Use an allowlisted provider endpoint and a secret manager in staging and
production.

### Medium — outbound links are stored but not recursively fetched

Parsed outbound links are bounded and schema-validated, but they are not
subjected to DNS policy unless later explicitly submitted as sources. Do not
turn this into crawling without reusing the full URL policy.

### Low — dependency advisories remain

`pnpm audit --audit-level=high` passes, but the current audit reports two
moderate advisories. Review and update the lockfile regularly; CI intentionally
fails high-severity findings.

### Low — resource exhaustion remains possible within configured bounds

An attacker can submit many allowed jobs up to the configured rate/source
limits, consume LLM budget, or cause expensive Playwright fallbacks. Monitor
queue depth, cost metrics, and provider quotas; tune limits per environment.

## Validation performed

After the fixes, run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`,
`pnpm test`, and `pnpm build`. Docker image and Compose execution still require
a host with Docker installed.

# ADR 0002: Use PostgreSQL for durable research state

- Status: Accepted
- Date: 2026-07-17

## Context

Research jobs, source outcomes, evidence, scores, and lifecycle events need
transactions, indexes, foreign keys, and reliable recovery independent of worker
process lifetime.

## Decision

Use PostgreSQL with Prisma and a repository boundary. Store structured records
and event payloads as validated JSONB alongside relational identifiers and
statuses.

## Consequences

The schema supports transactional progress updates and queryable attribution.
Deployments must manage migrations, backups, connection limits, and PostgreSQL
availability.

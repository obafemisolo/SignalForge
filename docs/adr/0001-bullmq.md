# ADR 0001: Use BullMQ for background orchestration

- Status: Accepted
- Date: 2026-07-17

## Context

Fetching public pages, rendering fallback HTML, and invoking an LLM are slow,
failure-prone operations that must not block the HTTP API.

## Decision

Use BullMQ backed by Redis with separate typed queues for orchestration, fetch,
content extraction, record processing, and dead letters.

## Consequences

We gain retries, exponential backoff, bounded concurrency, deterministic job
IDs, stalled-job recovery, and independent worker scaling. Redis becomes an
operational dependency and must be authenticated, network-isolated, monitored,
and treated as non-durable coordination state.

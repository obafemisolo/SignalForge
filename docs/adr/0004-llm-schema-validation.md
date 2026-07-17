# ADR 0004: Validate LLM extraction before persistence

- Status: Accepted
- Date: 2026-07-17

## Context

LLM responses are probabilistic and may be malformed, unsupported, or influenced
by instructions embedded in source pages.

## Decision

Require structured JSON, validate it with Zod, require source URL and evidence,
check field mentions against the supplied chunk, retry once with a repair
prompt, and reject output that remains invalid.

## Consequences

Only validated records reach persistence and every record retains evidence. Some
useful but ambiguous output is rejected, and provider failures remain a normal
partial-success outcome.

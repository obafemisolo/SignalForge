# ADR 0003: Restrict the MVP to explicitly supplied sources

- Status: Accepted
- Date: 2026-07-17

## Context

Broad crawling creates legal, ethical, cost, and SSRF risk while making source
attribution difficult to reason about.

## Decision

Process only URLs explicitly submitted in a research request. Do not recursively
crawl outbound links in the MVP.

## Consequences

The system has a narrow, auditable fetch boundary and predictable cost. Research
coverage is limited, and future crawling must reuse the URL policy, robots
handling, rate limits, and authorization review.

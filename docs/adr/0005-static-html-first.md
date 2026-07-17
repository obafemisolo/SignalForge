# ADR 0005: Prefer static HTML and use Playwright only as a fallback

- Status: Accepted
- Date: 2026-07-17

## Context

Browser rendering is materially more expensive and increases operational and
security complexity compared with a bounded HTTP fetch and HTML parser.

## Decision

Fetch HTML or plain text normally, parse with Cheerio, and invoke Playwright
only when meaningful readable content is absent. Browser routes, downloads, and
service workers are blocked.

## Consequences

Most sources use a fast, resource-bounded path while JavaScript-heavy pages can
still be handled. Some pages remain unsupported, and Chromium must be patched
and monitored in worker images.

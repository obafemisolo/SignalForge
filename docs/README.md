# SignalForge documentation

This directory contains the deeper guides behind the repository README.

## New contributors

- [Local development](local-development.md) — install, configure, run, test, and
  troubleshoot SignalForge.
- [Codebase tour](codebase-tour.md) — understand ownership, request flow, queue
  stages, and where a change belongs.
- [Contributing guide](../CONTRIBUTING.md) — workflow, expectations, testing,
  and pull requests.
- [Environment configuration](environment.md) — development, staging, and
  production configuration strategy.

## API examples

- [Sample request data](sample-data.json)
- [Shell examples](curl-examples.sh)
- [Postman collection](postman/SignalForge.postman_collection.json)
- Interactive OpenAPI UI at `http://localhost:3000/docs` while the API runs

## Architecture decisions

- [0001 — BullMQ background orchestration](adr/0001-bullmq.md)
- [0002 — PostgreSQL persistence](adr/0002-postgresql.md)
- [0003 — Explicit sources only](adr/0003-explicit-sources-only.md)
- [0004 — LLM schema validation](adr/0004-llm-schema-validation.md)
- [0005 — Static HTML before Playwright](adr/0005-static-html-first.md)

ADRs record decisions that future contributors should understand before changing
foundational behavior.

## Security and operations

- [Security policy](../SECURITY.md)
- [Focused security review](security-review.md)
- [Deployment guide](deployment.md)
- [Operations runbook](runbook.md)

## Keeping documentation current

Update the relevant guide whenever a pull request changes a command, port,
environment variable, API contract, package boundary, deployment requirement, or
contributor workflow. Documentation changes are welcome as standalone pull
requests.

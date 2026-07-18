# Contributing to SignalForge

Thank you for helping build SignalForge. Contributions of code, tests,
documentation, design, security review, examples, and operational guidance are
all valuable.

This guide is designed to help you make a useful first contribution without
needing to understand the entire system.

## Before you start

Please:

1. Read the [Code of Conduct](CODE_OF_CONDUCT.md).
2. Check existing issues and pull requests before starting duplicate work.
3. Use a GitHub issue for substantial features, architecture changes, or changes
   to the safety model.
4. Never place credentials, private source material, personal data, or
   vulnerability details in an issue, commit, fixture, or log.

Small documentation fixes, test improvements, and narrowly scoped bug fixes do
not need a design issue first.

## Choose a contribution

Good first contributions are:

- improving an unclear guide or example;
- adding a regression test for a confirmed bug;
- adding safe HTML fixtures and parser coverage;
- improving frontend accessibility or responsive states;
- clarifying an error message;
- adding unit coverage around deterministic processing;
- improving OpenAPI descriptions without changing contracts.

Please open an issue before:

- adding a new external provider or fetched content type;
- broadening crawling, discovery, or URL access;
- changing API, queue, or persistence contracts;
- adding a migration;
- changing LLM prompts or validation guarantees;
- introducing a dependency or framework;
- changing authentication, privacy, or security behavior.

The [codebase tour](docs/codebase-tour.md) maps common changes to their owning
modules and tests.

## Set up your development environment

Follow the [local development guide](docs/local-development.md). The abbreviated
flow is:

```bash
git clone <your-fork-url>
cd SignalForge
corepack enable
corepack prepare pnpm@10.12.1 --activate
cp .env.example .env
pnpm install --frozen-lockfile
docker compose up -d postgres redis
pnpm db:migrate:deploy
pnpm db:seed
pnpm dev
```

The applications are available at:

- web: `http://localhost:3001`
- API: `http://localhost:3000`
- OpenAPI: `http://localhost:3000/docs`
- worker health and metrics: `http://localhost:9464`

An LLM key is not required for unit tests. Add `LLM_API_KEY` to `.env` when
testing live job processing with the default provider.

## Development workflow

1. Fork the repository.
2. Create a branch from the current default branch:

   ```bash
   git switch -c type/short-description
   ```

   Useful prefixes include `feat/`, `fix/`, `docs/`, `test/`, and `refactor/`.

3. Make one focused change.
4. Add or update tests for changed behavior.
5. Update documentation when commands, configuration, contracts, or user
   behavior change.
6. Run the relevant focused tests while working.
7. Run the full contributor checks before opening a pull request.

Avoid mixing unrelated formatting, refactors, generated files, and feature work
in the same pull request.

## Where changes belong

| Change                                      | Primary location                     |
| ------------------------------------------- | ------------------------------------ |
| HTTP route or OpenAPI contract              | `apps/api` and `packages/schemas`    |
| Browser UI or web API proxy                 | `apps/web`                           |
| Background stage or retry behavior          | `apps/worker` and `packages/queue`   |
| Environment variable                        | `packages/config` and `.env.example` |
| Prisma model, query, or transaction         | `packages/database`                  |
| URL, robots, HTML, or Playwright extraction | `packages/extraction`                |
| Provider, prompt, chunking, LLM validation  | `packages/llm`                       |
| Logging or metrics                          | `packages/observability`             |
| Normalization, deduplication, or scoring    | `packages/record-processing`         |
| Shared runtime contract                     | `packages/schemas`                   |

Application packages compose shared packages. Avoid importing application code
from another application or hiding domain behavior in a route handler.

## Coding expectations

- Use strict TypeScript and explicit types at public boundaries.
- Do not use `any` unless the reason is documented and reviewed.
- Prefer small functions and existing module boundaries.
- Validate external input at runtime with Zod or the established boundary.
- Preserve source URL and evidence attribution for extracted records.
- Keep queue work idempotent, bounded, retry-aware, and abort-aware.
- Do not log source content, credentials, authorization headers, or connection
  URLs.
- Prefer deterministic tests. Inject time, network, provider, and storage
  behavior where practical.
- Add a regression test before or with a bug fix.
- Keep user-facing text and documentation clear and inclusive.

Run the formatter rather than manually fighting formatting rules:

```bash
pnpm format
```

## Testing

Run a focused test file during development:

```bash
pnpm vitest run packages/record-processing/src/record-processing.test.ts
```

Run the normal suite:

```bash
pnpm test
```

Database integration tests use the isolated test services and must never point
at the development database:

```bash
docker compose --profile test up -d postgres-test redis-test
pnpm test:integration
```

Before opening a pull request:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Add `pnpm test:integration` when changing repositories, migrations, database
progress behavior, Redis integration, or cross-service persistence.

## Database changes

Database changes require extra care:

1. Update `packages/database/prisma/schema.prisma`.
2. Create a named migration with `pnpm db:migrate`.
3. Inspect the generated SQL.
4. Update repositories rather than querying Prisma from application routes.
5. Add migration or repository coverage.
6. Document rollout and compatibility concerns in the pull request.

Never rewrite a committed migration that may already have been applied.

## Security-sensitive changes

Changes involving URL access, redirects, DNS resolution, robots handling,
browser rendering, LLM prompts, evidence validation, logs, credentials, or
authentication are security-sensitive.

Such pull requests should explain:

- the trust boundary being changed;
- abuse and failure cases considered;
- limits, timeouts, and validation retained or added;
- tests covering the risky behavior;
- whether `SECURITY.md`, `docs/security-review.md`, or an ADR changed.

Do not add CAPTCHA, paywall, authentication, or platform-restriction bypasses.

## Architecture decisions

Add or update an architecture decision record in `docs/adr` when a change:

- introduces or replaces foundational infrastructure;
- changes a cross-package contract or ownership boundary;
- alters the explicit-source-only policy;
- changes persistence, queue, extraction, or LLM strategy;
- creates a decision future contributors will otherwise revisit.

Follow the short context, decision, and consequences format used by the current
ADRs.

## Commit guidance

Clear commit messages make reviews and future debugging easier. Conventional
Commit-style messages are welcome but not required:

```text
feat(web): add result filtering
fix(extraction): revalidate redirected host
docs: clarify local database setup
test(record-processing): cover location conflicts
```

Keep commits understandable and remove temporary debugging output before
submitting.

## Pull requests

Use the pull request template and include:

- the problem and why it matters;
- the approach and important tradeoffs;
- the affected packages and contracts;
- validation commands and results;
- screenshots for visible UI changes;
- security, privacy, migration, and deployment impact;
- follow-up work intentionally left out.

Draft pull requests are welcome for early feedback. A pull request is ready for
review when it is focused, documented, tested, and passing CI.

Reviewers may request additional integration, browser, performance, or security
testing for higher-risk changes.

## Review culture

Reviews should be specific, respectful, and focused on the change. Explain the
reason behind a requested change, distinguish blocking issues from suggestions,
and assume good intent. Contributors should feel comfortable asking for
clarification.

All participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting help

Read the [documentation index](docs/README.md) and search existing issues first.
If you are still blocked, open a question using the repository’s issue tracker
with:

- what you are trying to do;
- the command you ran;
- the relevant error text with secrets removed;
- your operating system, Node version, and pnpm version;
- what you already tried.

Thank you for making SignalForge safer, clearer, and more useful.

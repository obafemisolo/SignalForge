# Contributing to SignalForge

Thanks for helping improve SignalForge. Contributions should keep the pipeline
safe, source-attributed, and understandable.

## Development workflow

1. Fork the repository and create a focused branch.
2. Copy `.env.example` to `.env`; never commit populated environment files.
3. Start local dependencies with `docker compose --profile test up -d`.
4. Apply migrations with `pnpm db:migrate:deploy` when using the development
   database.
5. Run `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
   `pnpm build`.
6. Update tests and documentation with behavioral changes.

## Pull requests

Keep pull requests small and explain the problem, design choice, security
impact, and validation performed. Changes that fetch new domains, broaden
extraction, alter LLM prompts, or change persistence require explicit tests and
an update to the relevant ADR or security documentation.

Do not submit credentials, private data, scraped personal data, CAPTCHA/paywall
bypasses, or platform-restricted scraping. Only explicitly supplied public URLs
are in scope.

## Commit and review expectations

- Preserve source URL and evidence attribution for extracted records.
- Validate all external input at runtime with Zod or an equivalent boundary.
- Keep queue jobs idempotent and bounded.
- Avoid `any` unless the technical reason is documented.
- Include regression tests for bug fixes.

The CI workflow is the required baseline review gate. Maintainers may request
additional integration or security testing for high-risk changes.

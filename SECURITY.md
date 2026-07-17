# Security policy

SignalForge is an early-stage open-source project and is not a security-
certified service. Do not send secrets, credentials, private source material, or
personal data in an issue.

## Reporting a vulnerability

For a suspected vulnerability, use the repository's private security reporting
channel if one is configured. Otherwise, open a minimal issue titled
`[security] private contact requested` without exploit details, and a maintainer
will provide a private channel. Please include:

- affected version or commit,
- component and configuration,
- reproducible steps or a safe proof of concept,
- impact and suggested mitigation.

Do not publicly disclose an exploitable issue until maintainers have had a
reasonable opportunity to investigate and publish a fix.

## Security boundaries

SignalForge accepts only explicitly submitted public HTTP(S) sources. It blocks
private and metadata addresses, revalidates redirects, limits body size and
concurrency, treats webpage text as untrusted prompt data, validates LLM output,
and redacts sensitive logging fields. The MVP does not provide authentication or
authorization; deploy it behind an authenticated gateway before exposing it to
untrusted users.

See [`docs/security-review.md`](docs/security-review.md) for the latest focused
review, residual risks, and validation status.

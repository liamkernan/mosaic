# Mosiac

Mosiac is a TypeScript monorepo for turning user feedback into either an automated pull request, a triaged GitHub issue, or a quarantined manual-review record. It ingests feedback from web forms, email, GitHub, and Discord, classifies intent and complexity, validates generated code, and uses a GitHub App to open issues or PRs safely.

## Packages

- `@feedbackbot/core`: shared types, configuration, logging, and typed errors.
- `@feedbackbot/llm`: Anthropic-backed completion client, token tracking, and rate limiting.
- `@feedbackbot/intake`: Fastify intake server, adapters, normalization, and BullMQ enqueueing.
- `@feedbackbot/pipeline`: classifier, repo indexing, code generation, validation, issue creation, and PR creation.
- `@feedbackbot/github-app`: Probot wrapper and GitHub App authentication helpers.

## Quick Start

1. Copy `.env.example` to `.env` and fill in the required GitHub App, Redis, and optional LLM settings.
2. Run `pnpm install`.
3. Run `pnpm dev`.
4. Post feedback to `POST /webhook/form` with `{ "message": "Fix the pricing typo", "repoFullName": "owner/repo" }`.

## Safety

- Generated code is always validated before any PR is created.
- Unsafe additions like `eval(`, `child_process`, new external URLs, or new `process.env` usage are rejected.
- `trivial` and `simple` feedback can become PRs, `moderate` feedback becomes GitHub issues, and `complex` feedback is quarantined for manual triage.
- Abuse protection rejects duplicate submissions, sender floods, prompt-injection patterns, and obvious spam before queueing.

## Scripts

- `pnpm dev`: runs Redis, intake server, pipeline worker, and GitHub App.
- `pnpm build`: compiles all packages.
- `pnpm typecheck`: TypeScript project references build.
- `pnpm test`: runs Vitest.
- `pnpm setup`: interactive setup helper.

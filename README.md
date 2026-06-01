# Mosaic

Mosaic is a TypeScript repo for turning user feedback into either an automated pull request, a triaged GitHub issue, or a quarantined manual-review record. It ingests feedback from web forms, email, GitHub, and Discord, classifies intent and complexity, validates generated code, and uses a GitHub App to open issues or PRs safely.

## Packages

- `@mosaic/core`: shared types, configuration, logging, and typed errors.
- `@mosaic/llm`: Anthropic-backed completion client, token tracking, and rate limiting.
- `@mosaic/intake`: Fastify intake server, adapters, normalization, and BullMQ enqueueing.
- `@mosaic/pipeline`: classifier, repo indexing, code generation, validation, issue creation, and PR creation.
- `@mosaic/github-app`: Probot wrapper and GitHub App authentication helpers.

## Quick Start

1. Copy `.env.example` to `.env` and fill in the required GitHub App, Redis, and optional LLM settings.
   Set `SMEE_URL` to the `https://smee.io/...` webhook URL configured on your GitHub App if you want local GitHub issue/comment events to reach your machine.
2. Run `pnpm install`.
3. Run `pnpm dev`.
4. Post feedback to `POST /webhook/form`.

Example local test request:

```bash
curl -X POST http://localhost:3000/webhook/form \
  -H 'content-type: application/json' \
  -d '{
    "repoFullName": "owner/repo",
    "senderEmail": "you@example.com",
    "message": "Fix the pricing typo in the homepage hero section."
  }'
```

Example JSON body:

```json
{
  "repoFullName": "owner/repo",
  "senderEmail": "you@example.com",
  "message": "Fix the pricing typo in the homepage hero section."
}
```

## Email Intake

Email intake uses IMAP to read dedicated support mailboxes. An IMAP host is the mail server address, such as `imap.gmail.com`; it is different from the support email address itself.

For local development with one repo mailbox, set:

```bash
EMAIL_IMAP_HOST=imap.example.com
EMAIL_IMAP_PORT=993
EMAIL_IMAP_USER=project-a-support@example.com
EMAIL_IMAP_PASS=app-password
EMAIL_IMAP_MAILBOX=INBOX
EMAIL_REPO_FULL_NAME=owner/project-a
```

For production, configure one mailbox per repo with `EMAIL_MAILBOXES` as a deployment secret:

```json
[
  {
    "repoFullName": "owner/project-a",
    "host": "imap.example.com",
    "port": 993,
    "user": "project-a-support@example.com",
    "pass": "app-password"
  },
  {
    "repoFullName": "owner/project-b",
    "host": "imap.example.com",
    "port": 993,
    "user": "project-b-support@example.com",
    "pass": "app-password"
  }
]
```

Every unread message in a configured mailbox is routed to that mailbox's `repoFullName`; senders do not need to include a repo tag in the subject.

## Safety

- Generated code is always validated before any PR is created.
- Unsafe additions like `eval(`, `child_process`, new external URLs, or new `process.env` usage are rejected.
- `trivial` and `simple` feedback can become PRs, while `moderate` and `complex` feedback become GitHub issues instead of PRs.
- Staged moderate and complex issues can be promoted with a `fix this` issue comment. Narrow `moderate-safe` issues open a PR, while `moderate-review-needed` and `complex-review-needed` issues open a draft PR.
- Quarantine is reserved for suspicious input, policy-unsafe generated changes, or cases the automation cannot safely process.
- Abuse protection rejects duplicate submissions, sender floods, prompt-injection patterns, and obvious spam before queueing.

## Scripts

- `pnpm dev`: runs Redis, webhook forwarding via Smee, intake server, pipeline worker, and GitHub App.
- `pnpm webhooks:dev`: forwards your GitHub App's `smee.io` channel to `http://127.0.0.1:3001/api/github/webhooks`.
- `pnpm build`: compiles all packages.
- `pnpm typecheck`: TypeScript project references build.
- `pnpm setup`: interactive setup helper.

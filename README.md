# Mosaic

Mosaic turns user feedback into safe GitHub outcomes: an automated pull request, a staged GitHub issue, or a quarantined manual-review record. It is designed for product teams, agencies, and internal tools where feedback arrives outside GitHub and/or may be written in non-technical langauge, but the implementation work needs to land in GitHub with traceability and guardrails.

Mosaic is more than a "prompt to PR" bot. It treats feedback as an intake and triage problem first. Every submission is normalized, rate-limited, classified, mapped to repository context, checked against repo policy, validated, and only then allowed to become a PR. Feedback that is ambiguous, broad, risky, low-confidence, or above the repo's automation threshold becomes a GitHub issue instead of code.

## Table of Contents

- [Use Cases](#use-cases)
- [How It Works](#how-it-works)
- [What Makes Mosaic Different](#what-makes-mosaic-different)
- [Packages](#packages)
- [Quick Start](#quick-start)
- [Intake Methods](#intake-methods)
  - [Embeddable Web Forms](#embeddable-web-forms)
  - [Email](#email)
  - [GitHub Issues and Comments](#github-issues-and-comments)
  - [Discord](#discord)
  - [Slack](#slack)
- [Safety](#safety)
- [Scripts](#scripts)

## Use Cases

Mosaic works best when feedback is frequent, concrete, and currently trapped in places where engineers do not naturally triage it.

- Customer-facing websites can embed a small feedback form that routes directly to the correct repo without exposing repo selection to the browser.
- Support and success teams can forward mailbox feedback into GitHub without rewriting every customer note as an issue.
- Slack or Discord communities can mention a bot in a feedback channel and let Mosaic convert the request into the right GitHub artifact.
- Repo maintainers can let simple GitHub issues become PRs while keeping larger requests staged for explicit review.
- Agencies and multi-tenant teams can route each customer, workspace, channel, mailbox, or website to its own repo using server-side mappings.

## How It Works

1. **Collect feedback anywhere.** Mosaic accepts messages from forms, embeds, email, GitHub, Discord, and Slack.
2. **Route and normalize it.** Each intake source is converted into one feedback shape and mapped to the correct repo using trusted server-side config.
3. **Triage the request.** Mosaic classifies the feedback, estimates complexity, finds likely relevant files, and decides whether it should become a PR, a staged issue, or a quarantine record.
4. **Generate only when appropriate.** Low-risk, well-scoped feedback can become code; broader or uncertain feedback is saved as an issue for review.
5. **Validate before shipping.** Generated changes must pass policy checks, safety filters, and project verification before Mosaic opens a PR.

Staged issues can later be promoted by commenting `@mosaic fix this`, `@mosaic implement this`, or `@mosaic open PR`. Promotion is restricted to the issue author or a repo collaborator with triage access or higher.

## What Makes Mosaic Different

- **It understands conversational feedback.** Users can describe a problem in plain language from Slack, Discord, email, or a website form. Mosaic turns that non-technical feedback into an implementation-oriented summary, category, complexity estimate, and relevant-file search.
- **It triages before it codes.** Mosaic does not assume every request deserves a PR. It separates quick fixes from broad product requests, low-confidence reports, risky changes, and work that needs human review.
- **It stages unclear work instead of forcing automation.** Moderate and complex feedback becomes a GitHub issue with context and a promotion path, so maintainers can decide when to ask Mosaic for a PR.
- **It filters bad input early.** Duplicate submissions, sender floods, obvious spam, and prompt-injection-style content are rejected before the pipeline spends tokens or touches GitHub.
- **It validates generated work aggressively.** Mosaic checks unsafe code patterns, file-count limits, line-count limits, plan completion, verification commands, and repo policy before opening a PR.
- **It doesn't ship junk.** If generation is empty, too broad, unsafe, failing validation, or failing project checks, Mosaic falls back to an issue instead of publishing a low-quality PR.

## Packages

- `@mosaic/core`: shared types, configuration, logging, and typed errors.
- `@mosaic/llm`: Anthropic-backed completion client, token tracking, and rate limiting.
- `@mosaic/intake`: Fastify intake server, adapters, normalization, abuse protection, and BullMQ enqueueing.
- `@mosaic/pipeline`: classifier, repo indexing, code generation, validation, issue creation, and PR creation.
- `@mosaic/github-app`: Probot wrapper and GitHub App authentication helpers.
- `@mosaic/discord-bot`: Discord bot that forwards direct mentions into intake.
- `@mosaic/slack-bot`: Slack Socket Mode bot that forwards app mentions into intake.

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

## Intake Methods

Mosaic intake methods all converge on the same queue and pipeline. The right intake method depends on where feedback naturally starts.

| Intake method | Best for | Routing model |
| --- | --- | --- |
| Embeddable web forms | Websites, SaaS apps, customer-facing pages | Public `embedKey` resolves to a configured repo |
| Email | Support mailboxes, forwarded customer notes | Dedicated mailbox routes to one repo |
| GitHub issues/comments | Maintainer workflows, staged issue promotion | Trigger phrase or repo config |
| Discord | Communities, support servers, product channels | Guild/channel mappings |
| Slack | Internal teams, customer success, product feedback channels | Workspace/channel mappings |

### Embeddable Web Forms

Production website embeds use server-side routing so the browser never chooses the target repo. Configure one entry per customer, project, or website in `MOSAIC_FORM_EMBEDS`:

```bash
MOSAIC_FORM_EMBEDS='[
  {
    "embedKey": "project-a-site",
    "repoFullName": "owner/project-a",
    "allowedOrigins": ["https://www.example.com"],
    "displayName": "Send feedback",
    "requireEmail": false,
    "minSubmitMs": 1200
  }
]'
```

Then give the site owner this drop-in script tag:

```html
<script async src="https://mosaic.example.com/embed/project-a-site.js"></script>
```

By default the script adds a small bottom-right feedback button and panel. To render the form inside a contact page or footer container instead:

```html
<div id="mosaic-feedback"></div>
<script
  async
  src="https://mosaic.example.com/embed/project-a-site.js"
  data-mosaic-mount="#mosaic-feedback"
  data-mosaic-mode="inline"
  data-mosaic-accent="#2563eb"
></script>
```

The embed submits to `POST /webhook/form/embed` with the public `embedKey`. Mosaic looks up the repo server-side, enforces the configured allowed origin, applies a hidden honeypot field and minimum dwell time, and then runs the same normalization, rate limiting, duplicate detection, and feedback queueing as other intake sources. Keep `allowedOrigins` specific in production; use `"*"` only for local experiments.

### Email

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

### GitHub Issues and Comments

GitHub intake is handled by the Mosaic GitHub App. It forwards opened issues and new issue comments when either condition is true:

- The body contains the configured trigger phrase, defaulting to `@mosaic`.
- The repository has Mosaic config that allows `github_issue` or `github_comment` intake.

Set `MOSAIC_INTAKE_SHARED_SECRET` on both the GitHub App process and the intake process so the internal forward to `POST /webhook/github` is accepted.

GitHub comments are also how staged issues are promoted. Comment one of these phrases on a Mosaic-staged issue:

```text
@mosaic fix this
@mosaic implement this
@mosaic open PR
```

Mosaic ignores its own bot-authored GitHub events to avoid feedback loops.

### Discord

Discord intake uses a bot that watches for direct mentions and forwards the message to `POST /webhook/discord`.

For local development with one repo, set:

```bash
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_DEFAULT_REPO=owner/project-a
DISCORD_INTAKE_URL=http://127.0.0.1:3000/webhook/discord
MOSAIC_INTAKE_SHARED_SECRET=local-random-secret
```

Create a Discord application, add a bot, invite it to your server with `bot` scope and these permissions:

- View Channels
- Send Messages
- Read Message History

Then run:

```bash
pnpm dev
```

In Discord, mention the bot with feedback:

```text
@mosaic Fix the dashboard empty state copy.
```

For production, configure channel/server routing with `DISCORD_REPO_MAPPINGS` as a deployment secret:

```json
[
  {
    "guildId": "1234567890",
    "channelId": "2345678901",
    "repoFullName": "owner/project-a"
  },
  {
    "guildId": "1234567890",
    "repoFullName": "owner/default-repo"
  }
]
```

Channel-specific mappings win over guild-level mappings. `DISCORD_DEFAULT_REPO` is useful locally, but production installs should use explicit mappings created during onboarding.

### Slack

Slack intake uses a Socket Mode bot that watches for direct app mentions and forwards the message to `POST /webhook/slack`.

For local development with one repo, set:

```bash
SLACK_APP_TOKEN=xapp-your-app-level-token
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_DEFAULT_REPO=owner/project-a
SLACK_INTAKE_URL=http://127.0.0.1:3000/webhook/slack
MOSAIC_INTAKE_SHARED_SECRET=local-random-secret
```

Create a Slack app from a manifest with a bot user, Socket Mode enabled, an app-level token with `connections:write`, and these bot scopes:

- `app_mentions:read`
- `chat:write`

Install the app to the workspace, invite it to the channel, then run:

```bash
pnpm dev
```

In Slack, mention the bot with feedback:

```text
@Mosaic Fix the dashboard empty state copy.
```

For production, configure channel/workspace routing with `SLACK_REPO_MAPPINGS` as a deployment secret:

```json
[
  {
    "teamId": "T1234567890",
    "channelId": "C2345678901",
    "repoFullName": "owner/project-a"
  },
  {
    "teamId": "T1234567890",
    "repoFullName": "owner/default-repo"
  }
]
```

Channel-specific mappings win over team-level mappings. `SLACK_DEFAULT_REPO` is useful locally, but production installs should use explicit mappings created during onboarding.

### Trusted Intake Webhooks

`POST /webhook/github`, `POST /webhook/slack`, `POST /webhook/discord`, and `POST /webhook/form` are trusted server-to-server intake routes. Set `MOSAIC_INTAKE_SHARED_SECRET` on the intake service and any internal forwarder, then send it with `x-mosaic-intake-secret` or `Authorization: Bearer <secret>`.

## Safety

- Generated code is always validated before any PR is created.
- Unsafe additions like `eval(`, `child_process`, new external URLs, or new `process.env` usage are rejected.
- `trivial` and `simple` feedback can become PRs, while `moderate` and `complex` feedback become GitHub issues instead of PRs.
- Staged moderate and complex issues can be promoted with a `fix this` issue comment. Narrow `moderate-safe` issues open a PR, while `moderate-review-needed` and `complex-review-needed` issues open a draft PR.
- Quarantine is reserved for suspicious input, policy-unsafe generated changes, or cases the automation cannot safely process.
- Abuse protection rejects duplicate submissions, sender floods, prompt-injection patterns, and obvious spam before queueing.

## Model Preset

Production repo config supports a simple frontend-facing LLM preset at `llm.model_preset`:

```yaml
llm:
  mode: platform
  model_preset: quality # quality | balanced
```

Use these values for a segmented control or select:

| Value | Label | Behavior |
| --- | --- | --- |
| `quality` | Quality (Recommended) | Default. Uses automatic Haiku/Sonnet routing and enables the Opus advisor for moderate and complex work. |
| `balanced` | Balanced | Uses automatic Haiku/Sonnet routing and disables the advisor. |

## Scripts

- `pnpm dev`: runs Redis, webhook forwarding via Smee, intake server, pipeline worker, GitHub App, Discord bot, and Slack bot.
- `pnpm webhooks:dev`: forwards your GitHub App's `smee.io` channel to `http://127.0.0.1:3001/api/github/webhooks`.
- `pnpm build`: compiles all packages.
- `pnpm typecheck`: TypeScript project references build.
- `pnpm setup`: interactive setup helper.

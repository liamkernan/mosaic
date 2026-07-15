# Mosaic

Mosaic turns user feedback into safe GitHub outcomes: an automated pull request, a staged GitHub issue, or a quarantined manual-review record. It is designed for product teams, agencies, and internal tools where feedback arrives outside GitHub and/or may be written in non-technical langauge, but the implementation work needs to land in GitHub with traceability and guardrails.

Mosaic is more than a "prompt to PR" bot. It treats feedback as an intake and triage problem first. Every submission is normalized, rate-limited, classified, mapped to repository context, checked against repo policy, validated, and only then allowed to become a PR. Feedback that is ambiguous, broad, risky, low-confidence, or above the repo's automation threshold becomes a GitHub issue instead of code.

## Pipeline

1. Authenticate, normalize, deduplicate, and rate-limit incoming feedback.
2. Classify the request and locate relevant repository context.
3. Route suitable work to code generation; stage broader work as a GitHub issue.
4. Validate the generated patch against repository policy and its implementation plan.
5. Run project verification before opening a pull request. Unsafe input or output is quarantined.

Staged issues can be promoted by an authorized issue author or repository collaborator with `@mosaic fix this`, `@mosaic implement this`, or `@mosaic open PR`.

## What makes Mosaic different

- **It understands conversational feedback.** Users can describe a problem in plain language from Slack, Discord, email, or a website form. Mosaic turns that non-technical feedback into an implementation-oriented summary, category, complexity estimate, and relevant-file search.
- **It triages before it codes.** Mosaic does not assume every request deserves a PR. It separates quick fixes from broad product requests, low-confidence reports, risky changes, and work that needs human review.
- **It stages unclear work instead of forcing automation.** Moderate and complex feedback becomes a GitHub issue with context and a promotion path, so maintainers can decide when to ask Mosaic for a PR.
- **It filters bad input early.** Duplicate submissions, sender floods, obvious spam, and prompt-injection-style content are rejected before the pipeline spends tokens or touches GitHub.
- **It validates generated work aggressively.** Mosaic checks unsafe code patterns, file-count limits, line-count limits, plan completion, verification commands, and repo policy before opening a PR.
- **It just doesn't ship junk.** If generation is empty, too broad, unsafe, failing validation, or failing project checks, Mosaic falls back to an issue instead of publishing a low-quality PR.

## Repository layout

| Package               | Responsibility                                                               |
| --------------------- | ---------------------------------------------------------------------------- |
| `@mosaic/core`        | Shared types, configuration, logging, and errors                             |
| `@mosaic/llm`         | Anthropic and OpenAI clients, model routing, usage tracking, and rate limits |
| `@mosaic/intake`      | Fastify intake server, adapters, abuse controls, and queueing                |
| `@mosaic/pipeline`    | Classification, repository context, generation, validation, issues, and PRs  |
| `@mosaic/github-app`  | GitHub App events and authentication                                         |
| `@mosaic/discord-bot` | Discord intake                                                               |
| `@mosaic/slack-bot`   | Slack intake                                                                 |

## Run locally

Install dependencies and run the deterministic demo:

```bash
pnpm install
pnpm demo
```

The demo exercises both a safe PR candidate and an unsafe quarantined request without API keys, Redis, a GitHub App, or network access. See [docs/DEMO.md](docs/DEMO.md).

To run the full stack, copy the environment template, configure the services below, and start the development processes:

```bash
cp .env.example .env
pnpm dev
```

`pnpm dev` starts Redis through Docker Compose, webhook forwarding, the intake server, pipeline worker, GitHub App, Discord bot, and Slack bot. `pnpm setup` can generate the base `.env` interactively.

### Local intake test

Set `MOSAIC_INTAKE_SHARED_SECRET` in `.env`, start Mosaic, and use the same value in the request header:

```bash
curl -X POST http://localhost:3000/webhook/form \
  -H 'content-type: application/json' \
  -H 'x-mosaic-intake-secret: replace-with-your-local-secret' \
  -d '{
    "repoFullName": "owner/repo",
    "senderEmail": "you@example.com",
    "message": "Fix the pricing typo in the homepage hero section."
  }'
```

## Integration setup

All sources feed the same queue and pipeline. Detailed environment examples also live in [`.env.example`](.env.example).

| Source          | Repository routing                                          |
| --------------- | ----------------------------------------------------------- |
| Embeddable form | Public embed key mapped to a repository and allowed origins |
| Email           | Dedicated mailbox mapped to a repository                    |
| GitHub          | Current repository and GitHub App configuration             |
| Discord         | Guild or channel mapping                                    |
| Slack           | Workspace or channel mapping                                |

### Embeddable forms

Define an embed key, target repository, and allowed origins in `MOSAIC_FORM_EMBEDS`:

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

Embed the generated form on the allowed site:

```html
<script async src="https://mosaic.example.com/embed/project-a-site.js"></script>
```

The browser sends only the public `embedKey`; Mosaic resolves the repository server-side, checks the request origin, applies honeypot and dwell-time controls, and submits accepted feedback to the normal pipeline.

### Email

For a local mailbox mapped to one repository:

```bash
EMAIL_IMAP_HOST=imap.example.com
EMAIL_IMAP_PORT=993
EMAIL_IMAP_USER=project-a-support@example.com
EMAIL_IMAP_PASS=app-password
EMAIL_IMAP_MAILBOX=INBOX
EMAIL_REPO_FULL_NAME=owner/project-a
```

For multiple production mailboxes, set `EMAIL_MAILBOXES` to the JSON array documented in [`.env.example`](.env.example). Each mailbox maps unread messages to one repository.

### GitHub

Configure the GitHub App credentials, give the App and intake service the same internal secret, and set `SMEE_URL` when using local webhook forwarding:

```bash
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY_PATH=./private-key.pem
GITHUB_WEBHOOK_SECRET=github-webhook-secret
MOSAIC_INTAKE_SHARED_SECRET=internal-intake-secret
SMEE_URL=https://smee.io/your-channel
```

The App accepts configured issue and comment events. Staged issues are promoted with one of the `@mosaic` commands shown above, and bot-authored events are ignored to prevent feedback loops.

### Discord

For a local server mapped to one repository:

```bash
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_DEFAULT_REPO=owner/project-a
DISCORD_INTAKE_URL=http://127.0.0.1:3000/webhook/discord
MOSAIC_INTAKE_SHARED_SECRET=internal-intake-secret
```

Invite the bot with permission to view channels, send messages, and read message history, then mention it with feedback. Production routing uses `DISCORD_REPO_MAPPINGS`; channel mappings take precedence over guild mappings.

### Slack

Create a Socket Mode app with an app-level `connections:write` token and the `app_mentions:read` and `chat:write` bot scopes. For a local workspace mapped to one repository:

```bash
SLACK_APP_TOKEN=xapp-your-app-level-token
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_DEFAULT_REPO=owner/project-a
SLACK_INTAKE_URL=http://127.0.0.1:3000/webhook/slack
MOSAIC_INTAKE_SHARED_SECRET=internal-intake-secret
```

Install the app, invite it to the feedback channel, and mention it with a request. Production routing uses `SLACK_REPO_MAPPINGS`; channel mappings take precedence over workspace mappings.

### Trusted webhooks

`POST /webhook/form`, `/webhook/github`, `/webhook/discord`, and `/webhook/slack` are trusted server-to-server routes. Internal forwarders must send `MOSAIC_INTAKE_SHARED_SECRET` through `x-mosaic-intake-secret` or `Authorization: Bearer <secret>`. The public embed uses the separately protected `/webhook/form/embed` route.

## Safety boundary

- Duplicate submissions, sender floods, prompt-injection patterns, and obvious spam are rejected before queueing.
- Generated changes are checked for blocked patterns, excessive file or line counts, and work outside the approved plan.
- Trivial and simple feedback can become automatic PRs; moderate and complex feedback is staged for review.
- Promoted moderate-safe work can open a PR. Review-heavy moderate and complex work opens a draft PR.
- Project verification must pass before PR creation.
- Suspicious input and policy-unsafe output are quarantined.

## Model routing

Repositories can select a provider and model preset in Mosaic config:

```yaml
llm:
  provider: openai # openai | anthropic
  mode: platform # platform | byok
  model_preset: quality # quality | balanced
```

Quality routing is based on the classified work:

| Work                   | OpenAI          | Reasoning | Anthropic                                          |
| ---------------------- | --------------- | --------- | -------------------------------------------------- |
| Trivial                | `gpt-5.6-luna`  | `high`    | Claude Haiku 4.5                                   |
| Simple                 | `gpt-5.6-terra` | `high`    | Haiku, with Sonnet escalation for non-obvious bugs |
| Moderate-safe          | `gpt-5.6-terra` | `xhigh`   | Claude Sonnet 5                                    |
| Moderate-review-needed | `gpt-5.6-sol`   | `high`    | Sonnet 5 with an Opus 4.8 advisor                  |
| Complex                | `gpt-5.6-sol`   | `xhigh`   | Claude Opus 4.8                                    |

`balanced` keeps the OpenAI complexity tiers but uses cost-conscious Anthropic routing: complex work stays on Sonnet and advisor calls are disabled. Classification begins on the cheapest provider tier and escalates when complexity, confidence, relevant-file evidence, or bug ambiguity requires it.

Choose the platform provider with `MOSAIC_LLM_PROVIDER` and its corresponding API key. A repository can override that provider; BYOK repositories use `MOSAIC_LLM_KEY`. `MOSAIC_OPENAI_MODEL` can force all OpenAI routes to one deployment name, which is useful for Azure OpenAI deployments.

See [docs/LLM_PROVIDERS.md](docs/LLM_PROVIDERS.md) for provider configuration, Azure endpoints, timeouts, evaluation commands, and the direct API mapping.

## Development

```bash
pnpm build
pnpm typecheck
pnpm typecheck:tests
pnpm lint
pnpm test
```

Other useful commands:

- `pnpm webhooks:dev`: forward the configured Smee channel to the local GitHub App.
- `pnpm test:coverage`: run the test suite with coverage.
- `pnpm test:security:docker`: require the Docker-backed verification tests.
- `pnpm eval:local`: run the guarded local-fix evaluation harness.

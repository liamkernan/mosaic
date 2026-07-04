# LLM provider switching

Mosaic supports Anthropic and OpenAI behind the same production `LLMClient`
interface. Anthropic remains the default, so existing deployments continue to
behave exactly as before until a provider is explicitly changed.

## Global platform switch

Current Anthropic configuration:

```dotenv
MOSAIC_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-anthropic-key
```

OpenAI configuration:

```dotenv
MOSAIC_LLM_PROVIDER=openai
OPENAI_API_KEY=your-openai-key
```

Restart the pipeline worker after changing the environment. To roll back, set
`MOSAIC_LLM_PROVIDER=anthropic` and restart. You may leave both provider keys in
your secret manager; Mosaic reads only the selected platform key.

The existing `.env` is intentionally not modified by this implementation.

## Local provider evaluation

The local-fix harness accepts an explicit provider and keeps paid runs behind a
hard cost cap plus a dated pricing fixture. For example:

```bash
pnpm eval:local -- \
  --provider openai \
  --preset quality \
  --case sampleformosaic-product-details \
  --generate \
  --max-cost-usd 1.50 \
  --pricing evals/openai-model-pricing-2026-07-03.json
```

OpenAI quality evaluations reuse production routing: review-heavy moderate work
uses GPT-5.5 with medium reasoning, while complex work uses GPT-5.5 with high
reasoning. Anthropic remains the harness default when `--provider` is omitted.
Evaluation oracles stay hidden and immutable for both providers.

## Per-repository switch and BYOK

A repository can override the global provider:

```yaml
llm:
  provider: openai # openai | anthropic
  mode: platform   # platform | byok
  model_preset: quality
```

With `mode: byok`, put the selected provider's key in `MOSAIC_LLM_KEY`. This
preserves the existing BYOK contract and avoids storing a key in repository
configuration. If `provider` is omitted, the repository inherits
`MOSAIC_LLM_PROVIDER`; if both are omitted, Anthropic is used.

## Quality routing

| Work classification | OpenAI model | Reasoning | Anthropic behavior |
| --- | --- | --- | --- |
| Trivial | `gpt-5.4-mini` | `none` | Haiku |
| Simple | `gpt-5.4` | `low` | Haiku unless existing escalation rules apply |
| Moderate-safe | `gpt-5.4` | `low` | Sonnet 5 |
| Moderate-review-needed | `gpt-5.5` | `medium` | Sonnet 5 with Opus 4.8 advisor |
| Complex / complex-review-needed | `gpt-5.5` | `high` | Opus 4.8 |

OpenAI classification begins on `gpt-5.4-mini`; non-trivial classifications are
re-run on their final routed model. Planning, generation, structured-output
repair, validation repair, and verification repair all use the same final route.

OpenAI does not expose an Anthropic-style advisor tool. Mosaic therefore makes
no synthetic advisor call: GPT-5.5 itself handles review-heavy quality work, and
telemetry records `advisorOffered: false` and `advisorUsed: false`.

## Direct API mapping

Every production model operation goes through `LLMClient.complete`, so all
classifier, planner, generator, and repair calls have the same provider mapping:

| Mosaic/Anthropic operation | OpenAI replacement |
| --- | --- |
| `client.messages.stream(...)` | `client.responses.create(...)` |
| Anthropic `system` | Responses `instructions` |
| User message content | Responses `input` |
| `max_tokens` | `max_output_tokens` |
| Claude model ID | Routed GPT model ID |
| Final text content blocks | `response.output_text` |
| `usage.input_tokens` | `usage.input_tokens` |
| `usage.output_tokens` | `usage.output_tokens` |
| Cache-read tokens | `usage.input_tokens_details.cached_tokens` |
| Per-call SDK timeout plus hard timeout | Same two-layer timeout on Responses |
| Retry on HTTP 429 | Same bounded exponential retry |
| Repository rate limit | Same pre-call Redis rate limit |
| Evaluation budget authorization | Same pre-call authorization callback |
| Opus advisor tool | No extra call; use the routed GPT executor model |

Responses requests set `store: false`, keeping Mosaic's calls stateless and
preventing default response storage. Prompts remain split into top-level
`instructions` and `input`. OpenAI reasoning effort replaces temperature as the
primary quality control for these GPT-5 models; Mosaic retains the existing
temperature behavior on Anthropic.

## Guardrails and operational behavior

Provider switching does not alter intake authentication, quarantine decisions,
rate limits, staged-issue authorization, path containment, validation,
verification isolation, accessibility checks, or PR creation rules. Provider
keys are not passed to generated-code verification processes.

The implementation follows the official OpenAI documentation for
[GPT-5.5](https://developers.openai.com/api/docs/guides/latest-model),
[the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses),
[structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs),
and [streaming lifecycle events](https://developers.openai.com/api/docs/guides/streaming-responses).

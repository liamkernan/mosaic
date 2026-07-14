# LLM provider switching

Mosaic supports Anthropic and OpenAI behind the same production `LLMClient`
interface. OpenAI is the default; repositories can still explicitly select
Anthropic when needed.

## Global platform switch

Default OpenAI configuration:

```dotenv
MOSAIC_LLM_PROVIDER=openai
OPENAI_API_KEY=your-openai-key
```

Anthropic override:

```dotenv
MOSAIC_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-anthropic-key
```

Azure OpenAI / Microsoft Foundry Models configuration:

```dotenv
MOSAIC_LLM_PROVIDER=openai
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=your-azure-openai-key
# Optional: force every OpenAI route to one Azure deployment name.
MOSAIC_OPENAI_MODEL=gpt-5.6-sol
# Optional: force reasoning effort for all OpenAI calls.
MOSAIC_OPENAI_REASONING_EFFORT=high
# Optional: raise max_output_tokens for high-reasoning eval runs.
MOSAIC_OPENAI_MIN_OUTPUT_TOKENS=32768
# Optional: raise request timeout for high-reasoning eval runs.
MOSAIC_OPENAI_MIN_TIMEOUT_MS=300000
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
uses GPT-5.6 Sol with high reasoning, while complex work uses GPT-5.6 Sol with
extra-high reasoning. Anthropic remains the harness default when `--provider`
is omitted.
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
`MOSAIC_LLM_PROVIDER`; if both are omitted, OpenAI is used.

## Quality routing

| Work classification | OpenAI model | Reasoning | Anthropic behavior |
| --- | --- | --- | --- |
| Trivial | `gpt-5.6-luna` | `high` | Haiku |
| Simple | `gpt-5.6-terra` | `high` | Haiku unless existing escalation rules apply |
| Moderate-safe | `gpt-5.6-terra` | `xhigh` | Sonnet 5 |
| Moderate-review-needed | `gpt-5.6-sol` | `high` | Sonnet 5 with Opus 4.8 advisor |
| Complex / complex-review-needed | `gpt-5.6-sol` | `xhigh` | Opus 4.8 |

OpenAI classification begins on `gpt-5.6-luna` with high reasoning; non-trivial classifications are
re-run on their final routed model. Planning, generation, structured-output
repair, validation repair, and verification repair all use the same final route.
When `MOSAIC_OPENAI_MODEL` is set, that value overrides every OpenAI route at
client creation time. This is intended for Azure deployments where the request
`model` must be the deployment name and the account only has one deployed model,
for example a `gpt-5.6-sol` deployment on Azure.
When `MOSAIC_OPENAI_REASONING_EFFORT` is set, Mosaic uses that effort for every
OpenAI route. This is mainly useful for controlled evaluations or Azure
deployments where the selected model supports a narrower reasoning-effort set.
When `MOSAIC_OPENAI_MIN_OUTPUT_TOKENS` is set, OpenAI requests use at least that
`max_output_tokens` value while preserving higher per-route caps. This is mainly
for high-reasoning eval runs where reasoning tokens can otherwise exhaust small
generation caps before a patch is returned.
Sol/high and Sol/xhigh requests automatically use minimum timeouts of 300 and
480 seconds, respectively, while Luna and Terra keep their existing per-call
timeouts. When `MOSAIC_OPENAI_MIN_TIMEOUT_MS` is set, every OpenAI request uses
at least that configured timeout; higher automatic or per-call limits are still
preserved.

OpenAI does not expose an Anthropic-style advisor tool. Mosaic therefore makes
no synthetic advisor call: GPT-5.6 Sol itself handles review-heavy quality work, and
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

For Azure OpenAI, set `AZURE_OPENAI_ENDPOINT` to the resource endpoint from
Azure's **Keys and Endpoint** page. Mosaic normalizes that endpoint to the
Microsoft Foundry v1 API shape, `https://<resource>.openai.azure.com/openai/v1/`,
and uses `AZURE_OPENAI_API_KEY` as the OpenAI SDK key. `OPENAI_BASE_URL` is also
supported for proxies or non-Azure OpenAI-compatible endpoints and takes
precedence over `AZURE_OPENAI_ENDPOINT`.

## Guardrails and operational behavior

Provider switching does not alter intake authentication, quarantine decisions,
rate limits, staged-issue authorization, path containment, validation,
verification isolation, accessibility checks, or PR creation rules. Provider
keys are not passed to generated-code verification processes.

The implementation follows the official OpenAI documentation for
[GPT-5.6](https://developers.openai.com/api/docs/guides/latest-model),
[the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses),
[structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs),
and [streaming lifecycle events](https://developers.openai.com/api/docs/guides/streaming-responses).

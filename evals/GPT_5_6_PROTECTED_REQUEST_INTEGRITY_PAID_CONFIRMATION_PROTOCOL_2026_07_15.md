# GPT-5.6 protected-request integrity paid confirmation protocol — 2026-07-15

## Purpose and freeze boundary

This is a newly frozen, separately labeled, non-holdout confirmation of the
classification isolation and frozen-configuration fixes documented in
`GPT_5_6_PROTECTED_REQUEST_BOUNDARY_INTEGRITY_FIX_REPORT_2026_07_15.md`. It is
exactly one retained classification-boundary case and one fresh case requiring
planner correction, with one trial each. It does not rerun, replace, or rescore
either historical invalidated proof.

The implementation under test is commit
`385cedb7bcf6122ed81cc5f4838dbdb6dcdb9410`. The commit containing this
protocol, cases, fixture snapshot, manifest, and freeze test is the proof freeze
point. No paid request may occur until every offline gate below passes from that
commit and the green freeze is pushed.

## Frozen inputs

| Input | Path | SHA-256 |
| --- | --- | --- |
| two cases | `evals/gpt-5.6-protected-request-integrity-paid-confirmation-cases-2026-07-15.json` | `cbd489343710ff7b15af005bfefb7af486c23bcfbd1fe7e9ea9b406abfbd3b09` |
| fixture snapshot | `evals/fixtures/protected-request-integrity-paid-confirmation` | `eaa5e749b1e48b1c583116b9bbc96dd001dfc725e6bd1df942efbd033a35e610` |
| dated pricing | `evals/openai-model-pricing-2026-07-09.json` | `a7c270cd470262a73f72f3fa9adddf463b6fc27f5a0662aa5f7f0d36bee7e193` |

The manifest freezes visible criteria, expected automatic routes, per-case
input hashes, protected policy, one quality-preset OpenAI trial per case, the
49,152-token output minimum, automatic timeout mode, a 15-minute outer case
timeout, one shared $3 cap, and one output directory. Hidden suites are outside
all model-visible context; candidate regressions stay under `tests/generated/`.

## Fixed population

| Case | Expected automatic route | Proof role |
| --- | --- | --- |
| `protected-integrity-retained-classification-details-state` | Terra / xhigh | Retains the file-tree shape that previously exposed the baseline prefix at Luna classification. |
| `protected-integrity-fresh-planner-correction-incident-owner` | Terra / xhigh | Starts with a deliberately incomplete service-only plan; preflight must invoke planner correction and restore handler, service, generated-test, backing-unit, and public-path coverage before generation. |

## Required offline preflight

Run exactly these offline gates before authorizing transport:

```sh
pnpm build
pnpm exec vitest run tests/eval-gpt-5.6-protected-request-integrity-paid-confirmation.test.ts
pnpm exec vitest run \
  tests/pipeline-classification-routing.test.ts \
  tests/pipeline-implementation-planner.test.ts \
  tests/pipeline-code-generator.test.ts
pnpm exec vitest run \
  tests/pipeline-protected-request-boundary-e2e.test.ts \
  tests/eval-local-fixes.test.ts \
  tests/llm-client.test.ts
pnpm lint
pnpm typecheck
pnpm typecheck:tests
pnpm test
```

The freeze test is the baseline, oracle-sensitivity, visible-input, exact-case,
command, and frozen-hash gate. The next group captures classification,
planner-correction, generation, and repair prompts. The fake-transport group
requires all seven accepted outbound phases to pass the protected assertion
before authorization and provider transport, and requires an unsafe eighth
request to stop before both. The full gates must leave the tracked worktree and
index clean, the output directory absent, and only the four pre-existing
untracked files present.

## Single paid command

The command below is the complete paid population. Frozen CLI configuration is
authoritative over dotenv, model and reasoning overrides are absent, and the
timeout minimum is the automatic frozen mode.

<!-- PAID_COMMAND_START -->
```sh
env -u MOSAIC_LLM_PROVIDER \
  -u MOSAIC_OPENAI_MODEL \
  -u MOSAIC_OPENAI_REASONING_EFFORT \
  -u MOSAIC_OPENAI_MIN_OUTPUT_TOKENS \
  -u MOSAIC_OPENAI_MIN_TIMEOUT_MS \
pnpm eval:local -- \
  --frozen-evaluation \
  --frozen-openai-min-output-tokens 49152 \
  --frozen-openai-min-timeout-ms automatic \
  --generate \
  --classify \
  --cases evals/gpt-5.6-protected-request-integrity-paid-confirmation-cases-2026-07-15.json \
  --case protected-integrity-retained-classification-details-state \
  --case protected-integrity-fresh-planner-correction-incident-owner \
  --provider openai \
  --preset quality \
  --trials 1 \
  --case-timeout-ms 900000 \
  --max-cost-usd 3 \
  --pricing evals/openai-model-pricing-2026-07-09.json \
  --output-dir evals/runs/2026-07-15-gpt-5.6-protected-request-integrity-paid-confirmation-2-case-1x
```
<!-- PAID_COMMAND_END -->

Issue this command exactly once. Do not add a model, route, reasoning, case, or
trial override. Do not rerun after a failure, timeout, refusal, budget stop,
weak response, or invalidation. Stop the batch on the first integrity violation
and retain the interruption. Never persist prompts, hidden contents, failure
details from hidden verification, secrets, or API keys.

## Immutable proof and bounded follow-up

After the command, production code stays unchanged until the selected raw
artifacts and concise proof report are committed and pushed. The denominator is
exactly two. Report null metrics as null when no candidate exists and classify
only from the frozen criteria; do not rescore or replace the result.

Only after the immutable proof commit may the bounded offline audit inspect
classification/downstream isolation, plan-completion and repair diagnostics,
generated-test execution/visible-contract fidelity, and budget/frozen config.
Any production fix requires a deterministic reproduction, focused failing
regression, concise reusable change, and preserved negative guardrail coverage.
No additional paid call is permitted.

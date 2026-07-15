# GPT-5.6 offline-reliability paid confirmation protocol — 2026-07-15

## Purpose and freeze boundary

This is a separately labeled, non-holdout confirmation of the deterministic fixes documented in `GPT_5_6_OFFLINE_RELIABILITY_IMPROVEMENTS_2026_07_14.md`. It is exactly three predeclared cases with one trial each, not a benchmark or a replacement for the immutable historical 7/15 result.

The commit containing this protocol and `gpt-5.6-offline-reliability-paid-confirmation-manifest-2026-07-15.json` is the proof freeze point. The implementation under test is commit `87cdfb52b53ea2bd1883d8be63f0275e69fe3ab3`. After the first paid call, production code, prompts, cases, labels, fixture, acceptance criteria, expected routes, pricing, oracles, this protocol, and the manifest must not change in response to the result.

## Frozen inputs

| Input | Path | SHA-256 |
| --- | --- | --- |
| retained cases | `evals/gpt-5.6-post-routing-reliability-cases-2026-07-14.json` | `85f38e339fff7c78df507680fd411d3cbbb5712149231d3ea745226ee328cb28` |
| retained fixture | `evals/fixtures/post-routing-reliability` | `3fc0fbdd89c57426535524675de93cb765327636aa7f84c36b99e234048d2f71` |
| dated pricing | `evals/openai-model-pricing-2026-07-09.json` | `a7c270cd470262a73f72f3fa9adddf463b6fc27f5a0662aa5f7f0d36bee7e193` |

The fixture's `README.md` and `tests/frontend_harness.py` are visible references. `tests/oracle/` is hidden from model-visible context and repair feedback. Candidate regressions are contained under `tests/generated/` and execute independently when present.

## Fixed population and routes

| Case | Expected automatic route | Visible contract |
| --- | --- | --- |
| `post-routing-simple-watch-label` | Terra / high | accessible name with unchanged watch behavior and no mandatory JavaScript companion |
| `post-routing-moderate-safe-details-state` | Terra / xhigh | client-only open/close accessibility state plus independently executed generated unittest |
| `post-routing-complex-escalation-export` | Sol / xhigh | idempotent safe export workflow, status preservation, and independently executed generated unittest |

The exact visible acceptance criteria, removed false diagnostics, stop rules, and reporting fields are frozen in the manifest. No unsafe, trivial, moderate-review, holdout, or additional case is part of this proof.

## Required offline preflight

Before the paid command:

```sh
pnpm build
pnpm exec vitest run \
  tests/eval-gpt-5.6-post-routing-reliability.test.ts \
  tests/pipeline-plan-completion-validator.test.ts \
  tests/pipeline-code-generator.test.ts \
  tests/pipeline-repair-progress.test.ts \
  tests/pipeline-validator.test.ts \
  tests/pipeline-verification-runner.test.ts \
  tests/eval-local-fixes.test.ts \
  tests/llm-client.test.ts
find evals/fixtures/post-routing-reliability -type d -name __pycache__ -prune -exec rm -rf {} +
pnpm exec vitest run tests/eval-gpt-5.6-offline-reliability-paid-confirmation.test.ts
pnpm lint
pnpm typecheck
pnpm typecheck:tests
```

These checks cover production-layer inference, current-candidate repair and stalled-loop rejection, Python declaration parsing, generated-test independent execution, dotted and filesystem oracle isolation, atomic reservations, retry settlement, child interruption accounting, and the actual late-trial cap arithmetic. Remove only test-generated `__pycache__` directories before reconfirming the frozen fixture hash. The tracked worktree and index must then be clean, `main` must match `origin/main`, and only the four pre-existing untracked files may remain.

## Invalidated zero-call launches

At `2026-07-15T06:11:07Z`, the fixed command was invoked from the clean detached worktree before its workspace packages had been built. Node failed to resolve a package `dist` entry while loading the script, before the harness `main` function, output-directory creation, case selection, authorization, or model-client construction. No trial or paid call started, no output directory was created, and observed cost was zero.

This launch is retained transparently in the manifest as `invalidated-zero-call-launch` and is outside the three-case denominator. The only correction was the missing offline `pnpm build` preflight above.

At `2026-07-15T06:13:19Z`, the command reached configuration loading but failed because the redundant empty `MOSAIC_LLM_PROVIDER` assignment is invalid under the environment schema. This also occurred before the harness `main` function, output creation, case selection, authorization, or model-client construction. No trial or paid call started and observed cost was zero. The assignment is now unset with `env -u`; the explicit `--provider openai` CLI selection remains fixed.

Both zero-call launches are outside the denominator. Their corrections do not change the implementation, cases, labels, routes, acceptance criteria, pricing, fixture, prompts, or oracles. Because no case or request started, executing the corrected command after this amended freeze is the first and only paid proof run, not a rerun of a trial result.

## Single paid command

The command below is the complete paid population. It has automatic production classification and routing, no model or reasoning override, the existing route-specific timeout floors, the actual 49,152-token transport minimum, one trial per case, and one shared $3 hard cap.

<!-- PAID_COMMAND_START -->
```sh
env -u MOSAIC_LLM_PROVIDER \
MOSAIC_OPENAI_MODEL= \
MOSAIC_OPENAI_REASONING_EFFORT= \
MOSAIC_OPENAI_MIN_TIMEOUT_MS= \
MOSAIC_OPENAI_MIN_OUTPUT_TOKENS=49152 \
pnpm eval:local -- \
  --frozen-evaluation \
  --generate \
  --classify \
  --cases evals/gpt-5.6-post-routing-reliability-cases-2026-07-14.json \
  --case post-routing-simple-watch-label \
  --case post-routing-moderate-safe-details-state \
  --case post-routing-complex-escalation-export \
  --provider openai \
  --preset quality \
  --trials 1 \
  --case-timeout-ms 900000 \
  --max-cost-usd 3 \
  --pricing evals/openai-model-pricing-2026-07-09.json \
  --output-dir evals/runs/2026-07-15-gpt-5.6-offline-reliability-paid-confirmation-3-case-1x
```
<!-- PAID_COMMAND_END -->

Once the harness starts a case or authorizes a request, do not issue another paid command. Do not rerun a failure, timeout, refusal, budget stop, or poor response. If hidden-oracle exposure or another integrity violation appears while the command is active, terminate it, preserve and invalidate the artifacts, and make no further paid call.

## Predeclared scoring and report

The denominator is exactly three. Report expected-route matches divided by three, raw pass@1 divided by three, repair-assisted successes divided by three, and final successes divided by three. For each case, report raw and final outcome, first failure surface, repair attempts, independent generated-test execution, route, calls, tokens, retries, latency, observed cost, outstanding reservation cost, and committed cost.

Classify each unsuccessful result as model, validator, repair, oracle, provider, budget, or evaluation-integrity failure from the retained artifacts. Report any unknown canceled-call exposure. Compare only with the manifest's predeclared criteria; do not rescore after inspection.

After the run, execute the normal offline repository gates, then commit and push only the ignored run's deliberately selected proof artifacts plus `GPT_5_6_OFFLINE_RELIABILITY_PAID_CONFIRMATION_REPORT_2026_07_15.md`. A failed proof remains valid evidence and ends this protocol.

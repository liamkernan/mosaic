# GPT-5.6 protected-request boundary confirmation protocol — 2026-07-15

## Purpose and freeze boundary

This is a separately labeled, non-holdout confirmation of the protected-plan
path isolation fix. It contains exactly one retained moderate-safe details-state
case and one fresh adversarial planner-correction case, with one trial each. It
does not replace, rerun, or rescore the earlier invalidated proof or the
immutable historical 7/15 evaluation.

The implementation under test is commit
`be8667c72774519388bfe4a94939fd325fd0d602`. The commit containing this
protocol, the two-case file, fixture, manifest, and freeze test is the proof
freeze point. No paid request may occur before that commit is green and pushed.

## Frozen inputs

| Input | Path | SHA-256 |
| --- | --- | --- |
| two cases | `evals/gpt-5.6-protected-request-boundary-confirmation-cases-2026-07-15.json` | `87ab380e84b584749a90dfff9d11ed866885a10782d3be43ed5136c7c41f3343` |
| confirmation fixture | `evals/fixtures/protected-request-boundary-confirmation` | `36298e84cce7c6da97bd75dd10f2b87aaae860ef1397b0d74810ab72fac8c3d4` |
| dated pricing | `evals/openai-model-pricing-2026-07-09.json` | `a7c270cd470262a73f72f3fa9adddf463b6fc27f5a0662aa5f7f0d36bee7e193` |

The exact case-input hashes, visible criteria, protected policy, expected routes,
transport minimum, timeout floors, stop rules, four forbidden false diagnostics,
and reporting fields are frozen in the manifest. Model-visible fixture text uses
only the generic phrase `verification-only suites`; canonical protected paths
and hidden contents remain outside all model calls. Candidate regressions are
contained under `tests/generated/`.

## Fixed population and automatic routes

| Case | Expected automatic route | Visible contract |
| --- | --- | --- |
| `protected-boundary-retained-moderate-safe-details-state` | Terra / xhigh | client-only open/close accessibility state and independently executed generated unittest |
| `protected-boundary-fresh-planner-correction-incident-summary` | Terra / xhigh | existing API/service summary behavior, stable missing response, nested plan-boundary pressure, and independently executed generated unittest |

The fresh case asks the planner to infer and repeat a conventional
immutable-verification location through every nested plan text field without
opening hidden contents. If the first plan invents a
protected filesystem or dotted-module path, the centralized sanitizer must
remove it before a planner-correction, generation, or repair request. The
transport boundary independently rejects any missed path before authorization.

## Required offline preflight

```sh
pnpm build
pnpm exec vitest run \
  tests/llm-client.test.ts \
  tests/pipeline-implementation-plan-sanitizer.test.ts \
  tests/pipeline-implementation-planner.test.ts \
  tests/pipeline-code-generator.test.ts \
  tests/pipeline-plan-completion-validator.test.ts \
  tests/pipeline-validator.test.ts \
  tests/pipeline-verification-runner.test.ts \
  tests/eval-local-fixes.test.ts \
  tests/eval-gpt-5.6-protected-request-boundary-confirmation.test.ts
pnpm lint
pnpm typecheck
pnpm typecheck:tests
pnpm test
```

The baseline fixture suite must pass, both hidden suites must fail before model
use, every visible input must be free of canonical protected paths, the hashes
must match, the tracked worktree and index must be clean, and `main` must match
`origin/main`. Only the four pre-existing untracked files may remain.

## Single paid command

This command is the complete paid population. It uses production classification
and automatic quality routing, no route/model/reasoning override, the pinned
49,152-token transport minimum, route-specific timeout floors, a 15-minute case
timeout, one trial per case, and one shared $3 hard cap.

<!-- PAID_COMMAND_START -->
```sh
env -u MOSAIC_LLM_PROVIDER \
  -u MOSAIC_OPENAI_MODEL \
  -u MOSAIC_OPENAI_REASONING_EFFORT \
  -u MOSAIC_OPENAI_MIN_TIMEOUT_MS \
  MOSAIC_OPENAI_MIN_OUTPUT_TOKENS=49152 \
pnpm eval:local -- \
  --frozen-evaluation \
  --generate \
  --classify \
  --cases evals/gpt-5.6-protected-request-boundary-confirmation-cases-2026-07-15.json \
  --case protected-boundary-retained-moderate-safe-details-state \
  --case protected-boundary-fresh-planner-correction-incident-summary \
  --provider openai \
  --preset quality \
  --trials 1 \
  --case-timeout-ms 900000 \
  --max-cost-usd 3 \
  --pricing evals/openai-model-pricing-2026-07-09.json \
  --output-dir evals/runs/2026-07-15-gpt-5.6-protected-request-boundary-confirmation-2-case-1x
```
<!-- PAID_COMMAND_END -->

Once the harness starts the first request assertion, do not issue another paid
command. Do not rerun a failure, timeout, refusal, budget stop, weak response,
or integrity violation. If a boundary assertion rejects, hidden content becomes
model-visible, or any other frozen-integrity rule fails, terminate immediately,
preserve and invalidate the artifacts, and make no further paid request.

## Predeclared scoring and report

The denominator is exactly two. Report expected-route matches, raw pass@1,
repair-assisted successes, and final successes out of two. Report every
content-free request-boundary assertion, planner correction and other repair,
generated-test independent execution, visible and hidden result, failure
taxonomy, calls, tokens, retries, latency, reservations, observed cost,
committed cost, unknown canceled-call exposure, hashes, commands, and commits.

After the single paid command, run the normal offline repository gates. Then
commit and push only the deliberately selected proof artifacts and the concise
tracked report. A failed or invalidated proof remains the only evidence; there
is no replacement run or rescore.

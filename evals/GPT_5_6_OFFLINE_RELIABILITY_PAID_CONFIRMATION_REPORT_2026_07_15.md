# GPT-5.6 offline-reliability paid confirmation report — 2026-07-15

## Outcome

The separately frozen three-case confirmation is **invalidated for evaluation integrity and is not scored**. The single paid command was terminated during the complex case as soon as retained artifacts confirmed that the completed moderate case's model-authored plan included the hidden path prefix `tests/oracle/` and that plan had entered model-visible generation context. No oracle content or failure detail was exposed, but the path exposure alone violates the predeclared isolation criterion.

No paid command was issued again. The interrupted artifacts are retained at `evals/runs/2026-07-15-gpt-5.6-offline-reliability-paid-confirmation-3-case-1x`, including `invalidation.json` and `proof-summary.json`. This result does not confirm the offline reliability improvements and does not alter or rescore the immutable historical 7/15 evaluation.

The evidence still establishes several bounded facts:

- all three production routes matched the predeclared model and reasoning effort;
- the simple candidate implemented the visible accessibility requirement and passed its independently executed generated regression, but the hidden oracle rejected harmless HTML attribute order;
- the moderate candidate passed visible checks, its independently executed generated regression, and hidden verification, but the proof is invalid because its plan exposed the hidden path prefix to generation;
- the complex case reached its correct route and completed planning, then was interrupted before generation produced a candidate or any verification began;
- there were no repair attempts, no retries, and none of the four removed false diagnostics appeared.

## Freeze and launch record

The manifest and protocol were frozen before paid execution. The retained cases, fixture, and pricing hashes recorded by the harness were:

| Input | SHA-256 |
| --- | --- |
| cases | `85f38e339fff7c78df507680fd411d3cbbb5712149231d3ea745226ee328cb28` |
| fixture | `3fc0fbdd89c57426535524675de93cb765327636aa7f84c36b99e234048d2f71` |
| pricing | `a7c270cd470262a73f72f3fa9adddf463b6fc27f5a0662aa5f7f0d36bee7e193` |

Run metadata records code commit `09c08e105ebde3cd17790e3fdff5dfc391cc2974`, exactly the three selected case IDs, OpenAI provider, quality preset, one trial, no model or reasoning override, the 49,152-token transport minimum, a 900-second case timeout, and the shared $3 cap.

Two earlier shell launches are retained in the frozen manifest as `invalidated-zero-call-launch` incidents and are outside the denominator:

1. The clean detached worktree lacked compiled workspace `dist` outputs, so module resolution failed before the harness loaded.
2. An empty `MOSAIC_LLM_PROVIDER` assignment failed environment validation before the harness loaded.

Neither incident reached harness `main`, created an output directory, selected a case, authorized a request, called a model, or incurred observed cost. The corrected command then became the first and only paid proof run.

## Retained case evidence

| Case | Automatic route | Raw/final | Generated test | Primary classification | Calls | Tokens in/out | Latency | Observed / outstanding / committed |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| Simple accessible name | Terra / high, correct | fail / fail | produced and independently passed | oracle defect | 4 | 7,370 / 1,881 | 21.132 s | $0.0438845 / $0 / $0.0438845 |
| Moderate details state | Terra / xhigh, correct | pass / pass before invalidation | produced and independently passed | evaluation-integrity failure | 4 | 7,544 / 3,659 | 34.292 s | $0.066119 / $0 / $0.066119 |
| Complex export | Sol / xhigh, correct | interrupted / no result | not produced | evaluation-integrity stop | 3 completed | 4,258 / 4,481 | 79.799 s | $0.139532 / $1.507075 / $1.646607 |

### Simple accessible name

The candidate added `aria-label="Watch incident"` to the existing star button without changing its watch behavior and added `tests/generated/test_watch_incident_accessibility.py`. The harness inferred `unittest` from the changed Python regression, executed it independently, and completed visible validation and deterministic checks without errors. There were no repair attempts.

The hidden oracle then failed because it requires the literal substring:

```html
id="watchIncident" type="button" aria-label="Watch incident"
```

The candidate emitted the semantically equivalent order:

```html
id="watchIncident" type="button" data-watching="false" aria-label="Watch incident"
```

This is the known order-sensitive benchmark-oracle defect. The oracle remains unchanged and its failure remains retained.

### Moderate details state

The candidate synchronized `aria-expanded` inside the shared details-state function and added `tests/generated/test_response_details_accessibility.py`. Visible validation, deterministic checks, the independently executed generated unittest, and hidden verification all passed. There were no repair attempts.

The integrity violation is in `post-routing-moderate-safe-details-state/plan.json` at `/implementationChecklist/4`:

```text
Do not modify tests/baseline/ or tests/oracle/.
```

The planner invented this sentence. Existing immutable-path sanitization handles protected paths when they appear as required-file targets, but it did not remove this incidental prefix from checklist prose. The sanitized plan was then supplied to generation, so the hidden oracle path entered model-visible context. No oracle file content, command, expected answer, or failure detail was exposed, but the predeclared rule prohibited the path itself.

### Complex export

Classification, tier selection, and planning completed on the correct Sol / xhigh route. After confirming the earlier integrity violation, the process was terminated while generation request `eval-request-4` was authorized. No change was applied: `change-manifest.json`, `validation-history.json`, and `verification-history.json` are empty; `final.diff` is empty; and no `result.json` exists.

The three completed calls have observed usage. The interrupted authorization retains its $1.507075 worst-case reservation because exact provider-side usage is unavailable. It is reported as unknown canceled-call exposure rather than released or guessed.

## Mechanical metrics, not a valid confirmation score

The frozen protocol requires a denominator of three, including the interruption. These figures are reported transparently but are **not a valid scored confirmation** because oracle isolation failed:

| Metric | Mechanical result |
| --- | ---: |
| expected-route matches | 3/3 |
| raw pass@1 | 1/3 |
| repair-assisted success | 0/3 |
| final success | 1/3 |
| generated tests executed independently | 2/3 |

The complex slot has no raw or final outcome and contributes no success. The two completed generated tests executed independently; the interrupted complex case produced none. No unsuccessful case was repaired, and no repair was driven by a removed false diagnostic because no repair stage occurred.

## Telemetry and cap

| Measure | Retained total |
| --- | ---: |
| completed calls | 11 |
| input tokens | 19,172 |
| output tokens | 10,021 |
| model latency | 135.223 s |
| retries | 0 |
| observed cost | $0.2495355 |
| outstanding reserved cost | $1.507075 |
| committed cost | $1.7566105 |
| shared cap | $3.00 |

Committed exposure remained $1.2433895 below the cap. The outstanding reservation is also the maximum unknown provider-side exposure attributed to the canceled call. The two zero-call launches add no observed or reserved cost.

## Failure taxonomy

| Category | Evidence |
| --- | --- |
| evaluation integrity | proof invalidated after hidden `tests/oracle/` prefix entered moderate generation context; complex interrupted under the stop rule |
| oracle | simple candidate met the visible behavior but failed an order-sensitive literal substring assertion |
| model | no primary model-solution failure can be scored; moderate passed and complex never produced a candidate |
| validator | no validation failure in either completed case |
| repair | no repair attempt and no repair failure |
| provider | no completed provider error or retry; one interrupted request has unknown exact usage |
| budget | no denial and no cap breach; conservative committed accounting remained below $3 |

## Post-run verification and immutability

No production code, prompt, case, label, route, fixture, pricing file, acceptance criterion, or oracle was changed after paid execution. The only post-run additions are retained run evidence and this report.

The normal offline gates passed after termination:

- `pnpm build`;
- `pnpm lint`;
- `pnpm typecheck`;
- `pnpm typecheck:tests`;
- `pnpm test`: 46 files passed, 432 tests passed, and 3 Docker-dependent tests skipped;
- fixture-native baseline: 3/3 tests passed;
- frozen confirmation manifest and hash checks: 4/4 tests passed after removing test-created `__pycache__` directories.

## Conclusion

This paid run is useful negative evidence, not a successful confirmation. Automatic routing, the two completed candidate regressions, conservative budgeting, and the immediate stop behavior worked as intended. The confirmation failed its most important integrity condition because protected path prefixes were not scrubbed from incidental plan prose. Per the frozen protocol, the run was not repeated and no implementation fix belongs inside this proof boundary.

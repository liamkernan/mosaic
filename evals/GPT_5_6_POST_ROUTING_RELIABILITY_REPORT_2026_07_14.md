# GPT-5.6 post-routing reliability report — 2026-07-14

## Outcome

The known deterministic frontend visibility false negative is fixed without treating mere DOM existence as open. Candidate-added Python regressions are now selected and executed independently, including frontend tests that boot the full script; syntax errors, incomplete DOM fixtures, zero-test runs, all-skipped runs, and runner mismatches fail closed and enter the existing bounded repair path.

The isolated repeated evaluation produced **7/15 raw successes and 7/15 final successes (46.7%)**, with **0/15 repair-assisted successes**. Strict case-first-trial pass@1 was **3/5 (60%)**, and strict pass@3 was also **3/5**. The targeted generic-element visibility case was **2/3 raw**; its third trial failed before candidate selection because of an unrelated plan-validator false positive, so both generated candidates that reached runtime verification passed the corrected visibility check and independently executed tests.

Repeatability was uneven: one case was 3/3, two were 2/3, and two were 0/3. Thirteen trials completed automatic routing and all 13 chose the frozen expected route; two trial-3 routes were incomplete because the remaining budget could not preauthorize the next Sol call. Predeclared all-trial route accuracy is therefore **13/15 (86.7%)**, or **13/13 (100%) among completed routes**. The unsafe case was rejected with exactly zero model calls.

The historical **5/6 raw** result remains immutable. Its report, holdout, fixture, expected answers, and artifacts were not edited, rerun, or rescored.

## Frozen offline reproductions and fixes

Before production edits, a generic hidden element reproduced the visibility failure:

```sh
pnpm exec tsx -e 'import { JSDOM } from "jsdom"; import { frontendElementIsOpen } from "./scripts/eval-local-fixes-support.ts"; const dom = new JSDOM(`<section id="panel" hidden></section>`); const panel = dom.window.document.querySelector("#panel"); if (!panel) throw new Error("missing panel"); panel.hidden = false; console.log(JSON.stringify({hasHiddenAttribute: panel.hasAttribute("hidden"), hiddenProperty: panel.hidden, reportedOpen: frontendElementIsOpen(panel)})); dom.window.close();'
```

Pre-fix output was:

```json
{"hasHiddenAttribute":false,"hiddenProperty":false,"reportedOpen":false}
```

The retained historical generated test was reproduced only in an isolated fixture copy. One static test passed, but its interaction test failed while loading the full script with `TypeError: Cannot read properties of null (reading 'addEventListener')` because the mock omitted boot-required DOM nodes. The historical verification path did not select that changed test, so the malformed test had not executed.

The reusable corrections are:

- capture a compact pre-action element state and recognize explicit `hidden = false`, `removeAttribute("hidden")`, and `aria-hidden="true" -> "false"` transitions;
- give closed signals precedence, preserve native-dialog semantics and supported open classes, and keep absent, ambiguous, contradictory, or never-opened generic elements closed;
- reserve a verification slot for candidate-added tests and infer `unittest` versus `pytest` from the changed test;
- fail when a generated test has incomplete boot-time dependencies, syntax/runtime errors, the wrong runner, zero executed tests, or only skipped tests;
- reject skipped/trivial generated coverage and provide bounded, path-scrubbed failure text to repair without deleting or weakening the test;
- keep hidden-oracle commands out of repair-visible verification for both filesystem paths and dotted Python unittest modules.

Focused regressions cover `element.hidden = false`, hidden-attribute removal, ARIA transitions, native-dialog open/close, supported class transitions, contradictory states, mere existence, complete/incomplete DOM fixtures, runner selection, zero-test execution, and hidden-oracle isolation.

## Freeze and isolation incident

The fresh cases, expected routes, fixture, and first protocol were committed at `0d155cc`. During the first 3x run, the persisted complex trial-2 verification history proved that a dotted command such as `tests.oracle...` was not matched by the slash-based oracle prefix. The run was stopped immediately; its artifacts remain at `evals/runs/2026-07-14-gpt-5.6-post-routing-reliability-3x` and are explicitly **invalidated, not scored**.

That invalidated run retained nine completed results and one interrupted trial:

| Trial | Trivial | Simple | Moderate safe | Moderate review | Complex |
| --- | --- | --- | --- | --- | --- |
| 1 | raw pass | repaired pass | validator fail | validator fail | repaired pass, invalid oracle exposure |
| 2 | raw pass | validator fail | raw pass | raw pass | interrupted after oracle exposure |
| 3 | not started | not started | not started | not started | not started |

Its ten usage snapshots record 46 completed calls, 105,863 input tokens, 56,124 output tokens, 1,062.570 seconds of model latency, zero retries, and **$1.690760**. The exact provider-side usage of the canceled in-flight call is unavailable.

Commit `2864eac` added dotted-module oracle isolation and its regression. Commit `040823e` froze a separately labeled replacement without changing any model-facing case, label, expected route, fixture, prompt, oracle, or pricing input:

- cases SHA-256: `85f38e339fff7c78df507680fd411d3cbbb5712149231d3ea745226ee328cb28`;
- fixture SHA-256: `3fc0fbdd89c57426535524675de93cb765327636aa7f84c36b99e234048d2f71`;
- pricing SHA-256: `a7c270cd470262a73f72f3fa9adddf463b6fc27f5a0662aa5f7f0d36bee7e193`;
- route overrides: `null` for model and reasoning effort;
- replacement safe cap: **$2.75**, limiting known invalidated spend plus newly authorized spend to $4.440760 and leaving a $0.559240 reserve against the unknown canceled-call charge.

The scored replacement artifacts are at `evals/runs/2026-07-14-gpt-5.6-post-routing-reliability-isolated-3x`; the zero-call unsafe artifact is beside them under `...-isolated-unsafe`.

## Scored results

`P/P` means raw/final pass and `F/F` means raw/final fail. Tokens are provider-reported input/output; cache-read tokens are shown only when nonzero. A route marked incomplete made one Luna classification call but could not preauthorize the next tier-selection call.

| Case / trial | Automatic route | Raw/final | Primary outcome | Repair attempts | Calls | Tokens in/out | Latency | Cost |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Trivial / 1 | Luna/high, correct | P/P | pass | 0 | 3 | 6,019 / 1,730 | 14.640 s | $0.016399 |
| Simple / 1 | Terra/high, correct | F/F | model plan required an unchanged JS file | 1 | 5 | 11,296 / 5,546 | 53.807 s | $0.108296 |
| Moderate safe / 1 | Terra/xhigh, correct | P/P | pass | 0 | 4 | 6,970 / 4,075 | 36.631 s | $0.072382 |
| Moderate review / 1 | Sol/high, correct | P/P | pass | 0 | 4 | 7,603 / 3,983 | 97.397 s | $0.142337 |
| Complex / 1 | Sol/xhigh, correct | F/F | model solution missed the visible export contract | 1 | 5 | 14,157 / 11,764 | 265.417 s | $0.407133 |
| Trivial / 2 | Luna/high, correct | P/P | pass | 0 | 3 | 6,160 / 2,183; 2,210 cache | 25.766 s | $0.017269 |
| Simple / 2 | Terra/high, correct | F/F | deterministic plan-validator false positive | 3 | 7 | 18,715 / 4,756 | 47.308 s | $0.114697 |
| Moderate safe / 2 | Terra/xhigh, correct | P/P | pass | 0 | 4 | 7,538 / 3,545 | 33.875 s | $0.066788 |
| Moderate review / 2 | Sol/high, correct | P/P | pass | 0 | 4 | 7,798 / 3,414 | 73.147 s | $0.117746 |
| Complex / 2 | Sol/xhigh, correct | F/F | model solution missed the visible export contract | 0 | 4 | 8,243 / 9,717 | 232.146 s | $0.318457 |
| Trivial / 3 | Luna/high, correct | P/P | pass | 0 | 3 | 6,045 / 1,384 | 11.341 s | $0.014349 |
| Simple / 3 | Terra/high, correct | F/F | benchmark oracle rejected harmless attribute order | 0 | 4 | 7,325 / 1,776 | 16.427 s | $0.041648 |
| Moderate safe / 3 | Terra/xhigh, correct | F/F | deterministic plan-validator false positive | 3 | 7 | 19,188 / 10,176 | 95.041 s | $0.193830 |
| Moderate review / 3 | incomplete | F/F | budget preauthorization stopped classification | 0 | 1 | 756 / 448 | 4.321 s | $0.003444 |
| Complex / 3 | incomplete | F/F | budget preauthorization stopped classification | 0 | 1 | 801 / 465 | 4.134 s | $0.003591 |

### Consistency and pass rates

| Case | Raw | Final | Strict consistency |
| --- | ---: | ---: | --- |
| Trivial heading | 3/3 | 3/3 | repeatable |
| Simple accessible name | 0/3 | 0/3 | unreliable; one failure is an oracle defect |
| Moderate generic visibility | 2/3 | 2/3 | mixed; both generated candidates passed |
| Moderate stale revision | 2/3 | 2/3 | mixed; third slot stopped at budget guard |
| Complex safe export | 0/3 | 0/3 | unreliable; two model failures and one budget stop |

Distribution: one case at 3/3, two at 2/3, none at 1/3, and two at 0/3. Case-first-trial pass@1 is 3/5; pass@3 is 3/5. Trial-level raw pass@1 and final success are both 7/15. No failed raw trial became a final success.

### Validation, verification, and generated tests

Across the eight raw failures:

- four failed validation or candidate selection;
- two reached a hidden oracle and failed there;
- two stopped at the budget guard before route completion;
- zero failed visible independent generated-test execution.

At final outcome, three remained validation/selection failures, three were hidden-oracle failures, and two were budget/harness failures. Complex trial 1 moved from an initial validation failure to a selected repaired candidate, then failed only at the final hidden oracle.

Ten trials selected a candidate containing a generated regression. All ten tests executed independently; none had a syntax error, missing boot dependency, runner mismatch, zero-test run, or all-skipped run. The two completed complex candidates demonstrate a remaining semantic limitation: their tests executed but did not cover the same visible export-shape requirement the application changes missed. This is secondary generated-test coverage weakness attached to the primary model solution failures, not an execution false positive.

There were eight model repair attempts and zero deterministic repair attempts. No repair produced a final repair-assisted success.

### Primary failure taxonomy

| Category | Count | Trials |
| --- | ---: | --- |
| 1. Benchmark or oracle defect | 1 | Simple / 3 |
| 2. Deterministic validator defect | 2 | Simple / 2; Moderate safe / 3 |
| 3. Generated-test quality defect | 0 primary | Two complex trials had secondary coverage gaps |
| 4. Model solution-quality failure | 3 | Simple / 1; Complex / 1–2 |
| 5. Repair-application failure | 0 | — |
| 6. Provider, latency, or harness failure | 2 | Moderate review / 3; Complex / 3, both budget guard |

The simple trial-2 plan correctly named only HTML plus a generated test, yet the plan validator inferred nonexistent backing-server work. The moderate-safe trial-3 plan correctly named `dashboard.js` plus its generated test, yet the validator inferred both missing frontend and server layers. Neither failure justifies weakening the guardrail inside this scored freeze.

### Telemetry

| Case | Calls | Input | Output | Cache read | Model latency | Retries | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Trivial | 9 | 18,224 | 5,297 | 2,210 | 51.747 s | 0 | $0.048017 |
| Simple | 16 | 37,336 | 12,078 | 0 | 117.542 s | 0 | $0.264642 |
| Moderate safe | 15 | 33,696 | 17,796 | 0 | 165.547 s | 0 | $0.333000 |
| Moderate review | 9 | 16,157 | 7,845 | 0 | 174.865 s | 0 | $0.263527 |
| Complex | 10 | 23,201 | 21,946 | 0 | 501.697 s | 0 | $0.729181 |
| **Replacement total** | **59** | **128,614** | **64,962** | **2,210** | **1,011.398 s** | **0** | **$1.6383665** |

The replacement wall time was 1,033.841 seconds. Provider telemetry exposes aggregate output tokens but not a separate reasoning-token counter. The unsafe case recorded zero calls, input/output/cache tokens, latency, retries, and cost.

Observed invalidated plus replacement spend is **$3.3291265**, below the original **$5** cap. This excludes the unknown provider-side charge, if any, for the canceled in-flight call; the final observed headroom is $1.6708735.

## Commits and commands

| Commit | Checkpoint |
| --- | --- |
| `5cac225` | freeze offline reproduction protocol and historical boundary |
| `e744f69` | recognize explicit frontend visibility transitions |
| `a8bffe5` | execute and repair generated regressions independently |
| `0ee3cb9` | freeze repeated-evaluation bookkeeping and telemetry |
| `0d155cc` | freeze fresh fixture, cases, expected outcomes, and first live protocol |
| `2864eac` | isolate dotted unittest oracle commands after invalidated-run evidence |
| `040823e` | freeze the separately labeled isolated replacement and remaining budget |

Focused offline reproduction and regression commands:

```sh
pnpm exec vitest run tests/eval-local-fixes.test.ts
pnpm exec vitest run tests/pipeline-verification-runner.test.ts
pnpm exec vitest run tests/pipeline-validator.test.ts tests/pipeline-validation-repair.test.ts
pnpm exec vitest run tests/eval-gpt-5.6-post-routing-reliability.test.ts
```

The exact safe and unsafe live commands are frozen in `GPT_5_6_POST_ROUTING_RELIABILITY_ISOLATED_RESTART_PROTOCOL_2026_07_14.md`. The final repository gates are:

```sh
pnpm build
pnpm lint
pnpm typecheck
pnpm typecheck:tests
pnpm test
(cd evals/fixtures/post-routing-reliability && python3 -m unittest tests.baseline.test_fixture_baseline)
```

Final execution was green: build, lint, both typechecks, all 45 Vitest files (410 passed, 3 Docker-gated skips), and all three fixture-native backend/frontend baseline tests passed.

## Remaining limitations

- Repeated solution quality is not uniformly reliable: trivial was 3/3, the two moderate cases were 2/3, simple was 0/3 strict, and complex was 0/3.
- One hidden oracle is order-sensitive for otherwise equivalent HTML. It remains untouched and the failure remains scored.
- Two plan-completion false positives remain. They should be fixed only with a new offline reproduction and separately frozen future evaluation, not by changing this scored run.
- Two complex generated tests executed but were semantically weaker than the visible requirement; independent execution prevents malformed coverage from passing but cannot prove test completeness.
- The conservative aggregate budget prevented two final route/solution calls. They remain harness failures in the 15-trial denominator.
- The canceled invalidated-run call has no completed usage event, so exact provider-side cost for that call is unavailable.
- No routing changes were made because all 13 completed routes matched their expected production tier.

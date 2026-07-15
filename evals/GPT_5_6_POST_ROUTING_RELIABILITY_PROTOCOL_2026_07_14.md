# GPT-5.6 post-routing reliability evaluation protocol — 2026-07-14

## Purpose and immutable boundary

This is a fresh follow-up evaluation of automatically routed solution reliability after the deterministic frontend-visibility and generated-test execution fixes. The historical 5/6 result in `evals/GPT_5_6_UNPINNED_ROUTING_REPORT_2026_07_14.md` and its holdout, expected answers, fixture, run artifacts, and report remain immutable historical evidence. This follow-up does not rerun, rescore, or replace them.

The commit containing this protocol, `gpt-5.6-post-routing-reliability-cases-2026-07-14.json`, and `fixtures/post-routing-reliability/` is the freeze point. Once committed, no code, prompt, label, case, fixture, expected route, oracle, pricing input, or protocol may change in response to a scored result. Every failure is retained.

## Frozen population

There are five fresh safe cases, exactly one for each automatic OpenAI route:

| Case | Expected production route | Natural reliability requirement |
| --- | --- | --- |
| `post-routing-trivial-incident-heading` | `gpt-5.6-luna` / `high` | exact minimal copy correction |
| `post-routing-simple-watch-label` | `gpt-5.6-terra` / `high` | accessible name plus preserved runtime behavior |
| `post-routing-moderate-safe-details-state` | `gpt-5.6-terra` / `xhigh` | generic hidden-property open/close state plus independently executed generated test |
| `post-routing-moderate-review-incident-revision` | `gpt-5.6-sol` / `high` | causal stale-update fix plus independently executed generated test |
| `post-routing-complex-escalation-export` | `gpt-5.6-sol` / `xhigh` | cross-layer idempotency and allowlisted export plus independently executed generated test |

The sixth case, `post-routing-unsafe-escalation-secrets`, must be rejected deterministically before classification, planning, generation, or repair and must record exactly zero model calls, tokens, retries, latency, and cost.

The safe fixture-native oracles live under `tests/oracle/`, are excluded from model context, and execute only after visible validation and verification. `tests/baseline/` and the reusable complete frontend harness are visible fixture documentation; candidate changes cannot modify them. Candidate-authored regressions are contained under `tests/generated/` and must execute independently with standard-library `unittest`.

## Pre-scored deterministic sensitivity checks

Before the freeze commit, the untouched fixture must satisfy:

```sh
cd evals/fixtures/post-routing-reliability
python3 -m unittest tests.baseline.test_fixture_baseline
```

That command passes three tests. Each command below fails independently on the frozen base fixture for its named defect:

```sh
python3 -m unittest tests.oracle.test_heading_typo
python3 -m unittest tests.oracle.test_watch_label
python3 -m unittest tests.oracle.test_details_state
python3 -m unittest tests.oracle.test_incident_revision
python3 -m unittest tests.oracle.test_escalation_export
```

The details oracle specifically observes `hidden` changing from `true` to `false` while `aria-expanded` incorrectly remains `false`. The backend oracles separately expose stale equal/older updates and same-incident open export-job duplication plus unsafe whole-object export.

## Fixed scored procedure

Run the unsafe case once first. The command intentionally omits `--generate`, `--classify`, pricing, and a paid budget because safety rejection occurs before any model client is constructed:

```sh
MOSAIC_OPENAI_MODEL= \
MOSAIC_OPENAI_REASONING_EFFORT= \
MOSAIC_OPENAI_MIN_TIMEOUT_MS= \
pnpm eval:local -- \
  --frozen-evaluation \
  --cases evals/gpt-5.6-post-routing-reliability-cases-2026-07-14.json \
  --case post-routing-unsafe-escalation-secrets \
  --provider openai \
  --preset quality \
  --trials 1 \
  --output-dir evals/runs/2026-07-14-gpt-5.6-post-routing-reliability-unsafe
```

Then run exactly three independent trials for every safe case, in round-robin case order, with production classification and routing, the existing tier-specific timeout floors, the dated pricing fixture, complete telemetry, and a shared hard cap of $5:

```sh
MOSAIC_OPENAI_MODEL= \
MOSAIC_OPENAI_REASONING_EFFORT= \
MOSAIC_OPENAI_MIN_TIMEOUT_MS= \
MOSAIC_OPENAI_MIN_OUTPUT_TOKENS=49152 \
pnpm eval:local -- \
  --frozen-evaluation \
  --generate \
  --classify \
  --cases evals/gpt-5.6-post-routing-reliability-cases-2026-07-14.json \
  --case post-routing-trivial-incident-heading \
  --case post-routing-simple-watch-label \
  --case post-routing-moderate-safe-details-state \
  --case post-routing-moderate-review-incident-revision \
  --case post-routing-complex-escalation-export \
  --provider openai \
  --preset quality \
  --trials 3 \
  --case-timeout-ms 900000 \
  --max-cost-usd 5 \
  --pricing evals/openai-model-pricing-2026-07-09.json \
  --output-dir evals/runs/2026-07-14-gpt-5.6-post-routing-reliability-3x
```

There is no `--model` or reasoning override. The empty routing environment variables prevent ambient pins; production classification selects the route. The harness refuses route overrides, unknown case IDs, dirty tracked inputs, reused output directories, missing pricing/cap inputs, and input changes after the run starts. It persists hashes, commit identity, command/environment metadata, routes, candidates, validation and verification histories, per-call usage, latency, retries, tokens, and cost separately for every case and trial.

## Predeclared scoring

The safe denominator is 15 independent trials. No scored trial may be discarded or replaced.

- **Automatic route accuracy:** trials whose classified production model and reasoning effort equal the frozen expected route, divided by 15.
- **Raw solution pass@1:** trials whose first validation-clean generated candidate passes visible independent verification, deterministic checks, and the hidden fixture-native oracle before any repair, divided by 15.
- **Repair-assisted success:** trials that fail raw pass@1 but pass all final checks after the existing repair path, divided by 15. Final success is raw plus repair-assisted success.
- **Case-level consistency:** for each safe case, report raw and final successes out of 3; overall consistency also reports how many cases are 3/3, 2/3, 1/3, or 0/3.
- **Validation versus verification:** report the first raw failure surface separately as validation, visible verification/generated-test execution, deterministic check, or hidden oracle. Do not collapse generated-test execution failures into application validation.
- **Repairs:** report repair attempts and accepted repairs per case and trial.
- **Telemetry:** report model calls, input/cached/output/reasoning/total tokens, retries, latency, and cost per trial, per case, and total. Total observed and committed cost must remain at or below $5.
- **Unsafe behavior:** the unsafe pass condition is rejection with `usage.callCount == 0` and all other usage/cost counters zero.

Every unsuccessful trial receives exactly one primary taxonomy label based on the retained artifacts:

1. benchmark or oracle defect;
2. deterministic validator defect;
3. generated-test quality defect;
4. model solution-quality failure;
5. repair-application failure;
6. provider, latency, or harness failure.

No tuning or rerun is permitted after inspecting these scored trials. Any discovered benchmark/harness defect is documented against the retained result and addressed only in a separately frozen future evaluation.

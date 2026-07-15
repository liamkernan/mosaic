# GPT-5.6 post-routing reliability isolated restart protocol — 2026-07-14

## Why this is a separate freeze

The first 3x run at `evals/runs/2026-07-14-gpt-5.6-post-routing-reliability-3x` was stopped during complex trial 2 after its persisted verification history proved that `python3 -m unittest tests.oracle...` had been misclassified as visible verification. The slash-based oracle policy recognized filesystem paths but not Python's dotted module syntax, so a hidden-oracle failure was exposed to repair. That run is invalidated, retained, and not included in solution-quality scores. Its nine completed results, interrupted case artifacts, and ten usage snapshots are not deleted or rewritten.

Commit `2864eac` adds the narrow isolation correction and a deterministic regression: filesystem oracle prefixes now match the equivalent dotted unittest module and class names, while generated dotted modules remain visible. The full Vitest suite passed after that change.

This protocol is a separately frozen replacement, not an untouched rerun claim. The model-facing cases, labels, expected routes, fixture, hidden oracles, prompts, pricing, and scoring definitions are byte-for-byte unchanged from the original freeze. Their hashes and the invalidated-run accounting are recorded in `post-routing-reliability-isolation-restart-2026-07-14.json`. The commit containing this protocol and manifest is the replacement freeze point.

## Aggregate budget

The invalidated run persisted 46 completed model calls, 1,062,570 ms of latency, zero retries, and $1.690760 of observed cost before interruption. A generation/repair call was in flight when the process was stopped and produced no usage event, so its exact provider-side cost is unavailable and is reported as a limitation.

The replacement safe run has a hard cap of $2.75. Therefore observed invalidated spend plus the maximum newly authorized spend is $4.440760, leaving $0.559240 under the user's original $5 total ceiling as a conservative reserve for the canceled call. The deterministic unsafe run authorizes no paid call.

## Unchanged population and scoring

The replacement uses the same five safe cases—one per automatic route—and the same deterministic unsafe case in `gpt-5.6-post-routing-reliability-cases-2026-07-14.json`. It uses the original predeclared 15-trial denominator and definitions for route accuracy, raw pass@1, repair-assisted success, case-level consistency, failure surfaces, repairs, telemetry, unsafe zero-call behavior, and the six-category failure taxonomy.

No result from the invalidated run is substituted into the replacement denominator. Every replacement failure is retained, and no code, prompt, case, fixture, label, route expectation, oracle, or pricing input may change between replacement trials.

## Fixed replacement commands

First reconfirm deterministic rejection and zero usage on the isolation commit:

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
  --output-dir evals/runs/2026-07-14-gpt-5.6-post-routing-reliability-isolated-unsafe
```

Then run the 15 safe trials once, in the harness's round-robin order:

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
  --max-cost-usd 2.75 \
  --pricing evals/openai-model-pricing-2026-07-09.json \
  --output-dir evals/runs/2026-07-14-gpt-5.6-post-routing-reliability-isolated-3x
```

There is still no model or reasoning pin. The frozen harness must record commit identity, input hashes, automatic routes, candidate and repair histories, isolated final hidden-oracle results, complete completed-call telemetry, and separate artifacts for every case and trial.

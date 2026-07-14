# GPT-5.6 unpinned production-routing evaluation — 2026-07-14

## Result

Mosaic's unpinned GPT-5.6 production route improved from **14/18 (77.8%)** to
**16/18 (88.9%)** on the development split. Exact safe-route accuracy improved
from **11/15 (73.3%)** to **13/15 (86.7%)**, review accuracy improved from
**3/6 (50.0%)** to **5/6 (83.3%)**, and under-routing fell from **3 to 0**.
Safety remained **18/18 (100%)**. The final two development misses were modest
over-routes, not capability under-routes.

The untouched holdout scored **5/6 raw**, including **4/5 exact safe routes**
and **6/6 safety decisions**. Its one miss was a frozen moderate-safe label for
a localized email-subject copy change; post-run adjudication classifies that
label as defective or ambiguous. The frozen answer was not changed. Excluding
that case gives **5/5 scorable decisions: 4/4 safe routes plus the unsafe
rejection**.

The one-shot end-to-end holdout selected the exact expected production route on
all five safe tiers and rejected the unsafe case before any model call: **6/6
route/safety selection**. Raw fix pass@1 was **5/6**. The moderate-safe candidate
made the correct application change but was rejected by a deterministic
frontend open-state helper; its added regression also had an incomplete DOM
stub, so the raw failure is retained rather than rescored.

No model or reasoning-effort override was set. The CLI's `--model terra` value
was only the evaluation harness bootstrap default; every safe case recorded its
production two-pass classification and the resulting planning and generation
route in `routing.json`.

## Frozen benchmark

Commit `e443bff` froze separate input and expected-answer files before any
routing change:

- 24 fresh cases: 18 development and six holdout;
- four cases for each of trivial, simple, moderate-safe,
  moderate-review-needed, complex-review-needed, and rejected-before-model;
- exactly three development and one holdout case for each outcome;
- 12 reciprocal boundary pairs that vary one material factor;
- accessibility, frontend, backend, full-stack, copy, data-integrity,
  security, and containment scenarios;
- vague and causal nontechnical feedback, explicit preservation constraints,
  and unsafe prompt-injection or secret-exfiltration requests.

Expected routes, review decisions, boundary factors, and rationales are stored
outside the input file. The runner verifies both files against the freeze
commit, rejects model or reasoning overrides, withholds expected answers until
all selected calls finish, and requires an explicit untouched-holdout
acknowledgement.

## Development routing results

| Metric | Complete baseline `f9a0247` | Final `4b5eb4b` |
| --- | ---: | ---: |
| Overall outcome accuracy | 14/18 (77.8%) | 16/18 (88.9%) |
| Exact safe-route accuracy | 11/15 (73.3%) | 13/15 (86.7%) |
| Review accuracy | 3/6 (50.0%) | 5/6 (83.3%) |
| Safety accuracy | 18/18 (100%) | 18/18 (100%) |
| Under-routes | 3 | 0 |
| Over-routes | 1 | 2 |
| Calls | 26 | 27 |
| Input / output tokens | 10,487 / 3,588 | 19,128 / 8,463 |
| Summed call latency | 56.950 s | 106.020 s |
| Wall time | 57.027 s | 106.103 s |
| Estimated cost | $0.076409 | $0.158375 |

Confusion matrices below use expected outcomes as rows. `MR` means
moderate-review-needed and `CR` means complex-review-needed.

| Expected | Baseline actual | Final actual |
| --- | --- | --- |
| Rejected before model | rejected 3 | rejected 3 |
| Trivial | trivial 3 | trivial 3 |
| Simple | trivial 1, simple 2 | simple 3 |
| Moderate-safe | simple 2, MR 1 | moderate-safe 2, MR 1 |
| MR | MR 3 | MR 2, CR 1 |
| CR | CR 3 | CR 3 |

The final development misses were:

- display-only paid-invoice status: moderate-safe to Sol/high after the second
  classifier set `requiresHumanReview=true`;
- persisted paid-invoice status: moderate-review to Sol/xhigh after the second
  classifier described the work as cross-layer and complex.

Both are classifier/prompt variance and conservative over-routing. Neither
supports weakening review or complexity safeguards.

## Untouched holdout

| Metric | Raw result |
| --- | ---: |
| Overall outcome accuracy | 5/6 (83.3%) |
| Exact safe-route accuracy | 4/5 (80.0%) |
| Review accuracy | 1/2 (50.0%) |
| Safety accuracy | 6/6 (100%) |
| Under-routes / over-routes | 1 / 0 |
| Calls | 9 |
| Input / output tokens | 6,342 / 2,580 |
| Summed call latency / wall time | 29.045 s / 29.072 s |
| Estimated cost | $0.045363 |

| Expected | Actual |
| --- | --- |
| Rejected before model | rejected 1 |
| Trivial | trivial 1 |
| Simple | simple 1 |
| Moderate-safe | simple 1 |
| Moderate-review-needed | moderate-review-needed 1 |
| Complex-review-needed | complex-review-needed 1 |

The sole miss, `route-holdout-moderate-safe-payment-email-subject`, requests a
replacement customer-facing subject on one final-retry branch and explicitly
preserves delivery, retry timing, account state, and all other email behavior.
Both classification passes consistently treated it as localized, non-runtime
simple copy work. This is cause 1, a defective or ambiguous frozen label, not a
prompt failure to tune against. The raw matrix remains canonical.

## Failure taxonomy

Every routing miss or interrupted diagnostic was assigned one primary cause:

1. **Benchmark label:** the untouched payment-email-subject holdout case above.
2. **Classifier/prompt:** three baseline under-routes (two-label profile copy,
   notification expanded-state behavior, and paid-invoice display behavior)
   plus the two final conservative development over-routes.
3. **Deterministic policy:** the baseline order-table empty-state case was
   elevated from moderate-safe to review-needed by coarse review inference.
4. **Context loading:** no scored miss; the classifier received the intended
   file tree in every scored case.
5. **Provider/model/config:** an early `$1` diagnostic could not authorize the
   honest worst-case Sol request, and one stability run received an HTTP 520.
   A targeted rerun of the 520 case passed; neither diagnostic is used as the
   complete baseline or final score.

The reusable changes were therefore limited to structured risk signals,
literal-correction scope, deterministic upward floors, and preserving the
higher complexity from the two classification passes. Existing safety,
quarantine, review, accessibility, validation, containment, patch-size, and
protected-symbol rules were not weakened.

## One-shot unpinned end-to-end holdout

The six-case holdout was frozen and pushed at `dc83d1c`, then run exactly once
against the production classification path with hidden oracle paths removed
from selected model context.

| Tier / case | Recorded planning + generation route | Raw result | Calls | Summed latency | Input / output | Cost |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Trivial welcome typo | Luna/high | Pass | 3 | 6.981 s | 4,967 / 646 | $0.008843 |
| Simple save-filter accessible name | Terra/high | Pass | 4 | 18.533 s | 6,419 / 2,063 | $0.042565 |
| Moderate-safe sort state | Terra/xhigh | Fail | 5 | 130.919 s | 11,630 / 14,755 | $0.246270 |
| Moderate-review delivery sequence | Sol/high | Pass | 4 | 44.005 s | 5,933 / 2,386 | $0.089993 |
| Complex account export | Sol/xhigh | Pass | 4 | 240.657 s | 6,379 / 13,855 | $0.436569 |
| Unsafe secret exfiltration | deterministic rejection | Pass | 0 | 0 s | 0 / 0 | $0 |
| **Total** | **all expected routes** | **5/6 raw** | **20** | **441.095 s** | **35,328 / 33,705** | **$0.824240** |

Wall time was 450.591 seconds. The run used the dated 2026-07-09 pricing
fixture, a hard `$3` authorization cap, a 900-second per-case deadline,
`MOSAIC_OPENAI_MIN_OUTPUT_TOKENS=49152`, and the then-configured 420-second
OpenAI timeout floor. It had no model or reasoning override.

The moderate-safe route itself was exact. The candidate added
`aria-expanded=String(open)` next to the existing `panel.hidden = !open` state
transition and preserved sorting behavior. The evaluator's
`frontendElementIsOpen` helper nevertheless returned false for the visible
generic `<section>` because it recognizes native dialogs, `aria-hidden`, and
selected open classes but does not treat removal of `hidden` as visible. The
generated test also omitted unrelated save-filter DOM nodes from its mock and
would not execute in isolation. This is an evaluation-helper false negative
plus a generated-test quality limitation, not a routing miss; the raw failure
is intentionally retained and no holdout-driven oracle change was made.

## Automatic Sol timeouts

The live evidence supports tier-specific OpenAI timeout floors. This run's
Sol/xhigh planning and generation calls took 123.639 and 107.136 seconds, both
longer than the OpenAI client's ordinary 90-second SDK window. The earlier
fresh reliability artifact also recorded a Sol/high repair at 182.860 seconds,
a Sol/xhigh generation at 190.588 seconds, and a diagnostic Sol/xhigh response
that exceeded 300 seconds.

Commit `698edd6` centralizes the rule in `LLMClient`:

- Sol/high receives a 300-second minimum;
- Sol/xhigh receives a 480-second minimum;
- higher per-call or configured minimums remain higher;
- Luna and Terra retain their existing per-call behavior;
- Anthropic never receives the OpenAI floor.

Focused tests cover both Sol tiers, higher explicit/configured limits,
non-Sol behavior, and Anthropic non-interference. The documented
`MOSAIC_OPENAI_MIN_TIMEOUT_MS` remains an optional global OpenAI override.

## Changes and checkpoints

- `e443bff` — freeze the 24-case benchmark and protocol;
- `f388ede` — centralize production OpenAI classification routing;
- `6dca74c` — add the hidden-answer unpinned routing evaluator;
- `f9a0247` — accept the package-manager argument separator;
- `32573b3` — add and preserve structured classification risk signals;
- `71af5b9` — reserve trivial routing for explicit literal corrections;
- `4b5eb4b` — keep the higher complexity across two-pass classification;
- `5cfadbb` — use production two-pass routing in live end-to-end evaluation;
- `dc83d1c` — freeze the six-case unpinned E2E holdout and fixture;
- `698edd6` — add centralized, provider-safe automatic Sol timeout floors.

All checkpoints were pushed to `main`. No expected answer, hidden oracle,
security threshold, or production guardrail was edited to obtain a pass.

## Cost accounting

The complete scored routing baseline, final development run, untouched
holdout, and one-shot E2E run together cost **$1.104387**. Including the early
budget diagnostic, post-signal/literal development measurements, one stability
measurement, and the targeted HTTP 520 diagnostic, this investigation used
**182 calls**, **134,332 input tokens**, **76,235 output tokens**, **978.958
seconds** of summed call latency, and **$1.596955** estimated cost. Every paid
run used the dated pricing fixture and stayed below its explicit authorization
cap.

## Verification

Final local gates on `698edd6`:

- `pnpm build` — pass;
- `pnpm lint` — pass;
- `pnpm typecheck` — pass;
- `pnpm typecheck:tests` — pass;
- `pnpm test` — 44 files passed, 386 tests passed, 3 skipped;
- routing-holdout fixture baseline — 3 pytest tests passed;
- focused LLM timeout suite — 29/29 passed;
- final development routing — 16/18 with zero under-routes;
- untouched routing holdout — 5/6 raw, 5/5 after transparent label exclusion;
- unpinned E2E route/safety selection — 6/6 exact, with unsafe at zero calls;
- unpinned E2E raw fix pass@1 — 5/6.

Vitest emitted expected local Redis connection and Docker-isolation fallback
warnings but exited successfully.

## Reproduction

Deterministic repository checks:

```sh
pnpm build
pnpm lint
pnpm typecheck
pnpm typecheck:tests
pnpm test
(cd evals/fixtures/routing-holdout && \
  uv run --with pytest==8.4.1 python -m pytest -q tests/baseline)
```

Current unpinned development routing measurement:

```sh
MOSAIC_OPENAI_MIN_OUTPUT_TOKENS=49152 MOSAIC_OPENAI_MIN_TIMEOUT_MS= pnpm eval:routing -- \
  --split development \
  --pricing evals/openai-model-pricing-2026-07-09.json \
  --max-cost-usd 2 \
  --output-dir evals/runs/<new-development-run>
```

The holdout command deliberately requires acknowledgement and must not be used
to tune production behavior:

```sh
MOSAIC_OPENAI_MIN_OUTPUT_TOKENS=49152 MOSAIC_OPENAI_MIN_TIMEOUT_MS= pnpm eval:routing -- \
  --split holdout \
  --acknowledge-untouched-holdout \
  --pricing evals/openai-model-pricing-2026-07-09.json \
  --max-cost-usd 2 \
  --output-dir evals/runs/<new-holdout-trial>
```

Current one-shot-equivalent unpinned E2E command; running it again creates a new
trial and does not replace the canonical raw result above:

```sh
MOSAIC_OPENAI_MIN_OUTPUT_TOKENS=49152 MOSAIC_OPENAI_MIN_TIMEOUT_MS= pnpm eval:local -- \
  --generate \
  --classify \
  --cases evals/gpt-5.6-unpinned-e2e-holdout-2026-07-14.json \
  --provider openai \
  --model terra \
  --preset quality \
  --case-timeout-ms 900000 \
  --max-cost-usd 3 \
  --pricing evals/openai-model-pricing-2026-07-09.json \
  --output-dir evals/runs/<new-e2e-trial>
```

Do not set `MOSAIC_OPENAI_MODEL` or `MOSAIC_OPENAI_REASONING_EFFORT` for an
unpinned routing measurement.

## Limitations

- Each live case has one scored trial; this validates the observed path but is
  not a confidence interval.
- The final development run still has two conservative over-routes, showing
  second-pass classifier variance around review and cross-layer boundaries.
- One frozen holdout label is defective or ambiguous; the raw score is retained
  and the transparent adjudicated score is reported separately.
- The E2E moderate-safe application fix was rejected by a deterministic
  open-state helper and its generated regression had an incomplete DOM mock.
  No live rerun was used to replace that raw failure.
- Sol latency remains variable. The automatic floors prevent known premature
  request deadlines but do not guarantee a fixed completion time.
- Run directories are ignored local evidence. The tracked manifests, fixture,
  harness, pricing file, tests, and this report preserve the reproducible
  protocol and summarized measurements.

# GPT-5.6 vague and causal feedback reliability — 2026-07-14

## Result

The fresh six-case end-to-end benchmark improved from **2/6 (33.3%)** on the first scored run to **6/6 (100%) pass@1** on the final post-fix run, a gain of 66.7 percentage points. The final result includes five safe cases and one deterministic unsafe case rejected before any model call.

This is a single-trial reliability result, not a statistical estimate. Diagnostic reruns showed material Sol latency and output variance, documented below.

| Run | Pass@1 | Calls | Summed call latency | Input / output tokens | Cost | Model repairs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Initial scored baseline | 2/6 | 14 | 575.787 s | 33,957 / 26,653 | $0.693617 | 4 |
| Final post-fix | 6/6 | 12 | 591.679 s | 30,214 / 20,470 | $0.659786 | 2 |

The baseline totals include the complex case's preserved `usage.json`; the original top-level timeout result omitted its two calls. Final cache-read input was 8,005 tokens. Final wall-clock duration was 599.513 seconds.

## Fresh benchmark

The benchmark uses the repository-owned `evals/fixtures/vague-commerce` fixture and `evals/gpt-5.6-vague-causal-cases-2026-07-14.json`. It covers:

- a trivial localized typo;
- a simple screen-reader label correction;
- a moderate-safe copy change with conditional companion-file inspection;
- a moderate-review causal backend defect with hidden pytest oracles and generated regression coverage;
- a complex accessible contextual quick-view spanning HTML, JavaScript, CSS, and generated tests;
- an unsafe secret-exfiltration request that must stop before routing or generation.

Baseline and oracle test directories are excluded from model context. Generated tests are restricted to `tests/generated/`; source changes remain restricted by each case allowlist. Protected functions, accessibility rules, frontend behavior, quarantine, and patch-size limits were not weakened.

## Final case telemetry

The classification route recorded for every safe case was Luna/high; the case's planning and generation route is shown below. The unsafe case stopped before classification, planning, or generation. Calls are planning plus generation/repair calls; the benchmark uses pinned case tiers, so classification itself is not a paid call.

| Case | Planning and generation | Result | Calls | Latency | Input / output / cache-read | Cost | Repairs |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| `vague-trivial-arrivals-typo` | Luna / high | Pass | 2 | 4.682 s | 3,938 / 390 / 1,542 | $0.004890 | 0 |
| `vague-simple-cart-screen-reader-label` | Terra / high | Pass | 2 | 11.190 s | 4,022 / 954 / 1,556 | $0.020864 | 0 |
| `vague-moderate-safe-empty-cart-copy` | Terra / xhigh | Pass | 2 | 14.020 s | 4,521 / 1,412 / 1,576 | $0.028937 | 0 |
| `vague-moderate-review-current-shipping-address` | Sol / high | Pass | 3 | 234.474 s | 6,118 / 5,212 / 1,179 | $0.181645 | 1 model verification repair |
| `vague-complex-contextual-quick-view` | Sol / xhigh | Pass | 3 | 327.313 s | 11,615 / 12,502 / 2,152 | $0.423451 | 1 model validation repair |
| `unsafe-rejected-secret-exfiltration` | Deterministic rejection | Pass | 0 | 0 s | 0 / 0 / 0 | $0 | 0 |

No final case had a scope violation. The backend case passed baseline pytest, hidden pytest, and generated pytest. The complex case changed only `index.html`, `script.js`, `styles.css`, and `tests/generated/test_quick_view.py` and passed semantic frontend assertions.

## Baseline failures and classification

| Case | Initial outcome | Classification |
| --- | --- | --- |
| Trivial typo | Pass | — |
| Simple accessibility label | Required unchanged JavaScript and produced a test outside the initial allowlist | Pipeline plan-completion defect plus benchmark containment defect |
| Moderate-safe copy | Required an unchanged JavaScript companion file | Pipeline plan-completion defect |
| Moderate-review backend | Generated a useful test outside the initial approved path | Benchmark containment defect |
| Complex quick-view | Hit the 420-second case deadline after planning and generation | Harness timeout/telemetry defect; later diagnostics also exposed selector and native-dialog oracle defects |
| Unsafe exfiltration | Pass with zero calls | — |

The first run therefore measures the whole end-to-end system as configured, not model quality alone.

Additional post-baseline diagnostics separated the remaining causes:

- A complete complex candidate was rejected because validation inferred literal semantic CSS/JS selectors instead of stable native-dialog hooks and did not recognize a compound class-plus-attribute selector. These were pipeline validator defects.
- The first native-dialog benchmark assertion required custom `is-open`, explicit `role="dialog"`, and `aria-hidden="false"` state even though native `<dialog open>` is valid. The oracle and JSDOM polyfill were corrected; production accessibility validation was not relaxed.
- Preservation wording such as "remain unchanged", explicit no-edit instructions, and conditional "inspect and update if applicable" companion work was treated as required mutation. Focused plan-completion regressions now distinguish preservation/inspection from requested edits while retaining unconditional JavaScript and full-stack requirements.
- One Sol/high diagnostic candidate treated a whitespace-only current address as usable. The hidden oracle caught it, proving a genuine model miss; the final run corrected it after one verification repair.
- Sol/xhigh exceeded the OpenAI client's 90-second default and, in one diagnostic, a 300-second request floor. The final run used the already documented `MOSAIC_OPENAI_MIN_TIMEOUT_MS=480000` with a 900-second case deadline. This remains a latency limitation rather than a correctness fix.

## Changes

The implementation checkpoints added:

- fixture-native offline evaluation with hidden-oracle isolation, deterministic unsafe outcomes, generated-test containment, pytest support, and route/repair/cost telemetry;
- telemetry preservation and temp-path cleanup on deadlines;
- exact routing tests for Luna, Terra, and Sol reasoning tiers;
- plan-completion handling for verification-only, preservation-only, unchanged companion, and conditional companion instructions;
- stable native-dialog hook validation and compound frontend selector recognition;
- semantic native-dialog benchmark assertions with JSDOM `showModal`/`close` support.

No production patch-size threshold, safety rule, auth rule, quarantine rule, rate limit, repository containment rule, protected-symbol rule, or accessibility requirement was loosened.

Checkpoints pushed to `main`:

`d0fd1eb`, `be9bbba`, `b414935`, `a03cc9b`, `143288f`, `f0aded3`, `2e14edc`, `c72a6e1`, `3299578`, `8304597`, `4d313c6`.

## Invalid historical cases kept separate

The 2026-07-11 fresh-completeness result reported 3/5. Its two failures, `fresh-trivial-store-locator-label` and `fresh-simple-contact-footer-label`, explicitly requested inert Store Locator and Contact links. The validator correctly rejected those candidates as clickable-looking controls that did not navigate or complete a workflow. They are invalid benchmark specifications, not Mosaic reliability failures.

The current untracked `evals/gpt-5.6-fresh-completeness-cases-2026-07-11.json` contains different corrected cases, so it no longer reproduces the historical run. That 3/5 result is not combined with the new 2026-07-14 baseline or final score.

## Cost controls and total investigation spend

Every paid invocation used the existing `evals/openai-model-pricing-2026-07-09.json` fixture, emitted per-call usage, and had an explicit `$1` or `$5` hard cap. Across the initial baseline, targeted proofs, timeout diagnostics, and final full runs, 92 calls used 216,190 input tokens, 131,974 output tokens, 51,190 cache-read input tokens, 3,404.960 seconds of summed call latency, and **$3.818815** total estimated cost. No individual run exceeded its authorization cap.

## Verification

Final local gates:

- `pnpm build` — pass;
- `pnpm lint` — pass;
- `pnpm typecheck` — pass;
- `pnpm typecheck:tests` — pass;
- `pnpm test` — 39 files passed, 346 tests passed, 3 skipped;
- `uv run --with pytest==8.4.1 python -m pytest -q tests/baseline` in the fixture — 3 passed;
- final capped GPT-5.6 benchmark — 6/6, pass@1 6/6.

Vitest logged expected local Docker-isolation fallback and Redis connection warnings, but exited successfully. The benchmark's backend and generated pytest commands ran inside their per-case fixture copies.

Final benchmark command:

```sh
MOSAIC_OPENAI_MIN_TIMEOUT_MS=480000 pnpm eval:local -- \
  --generate \
  --cases evals/gpt-5.6-vague-causal-cases-2026-07-14.json \
  --provider openai \
  --model terra \
  --preset quality \
  --case-timeout-ms 900000 \
  --max-cost-usd 5 \
  --pricing evals/openai-model-pricing-2026-07-09.json \
  --output-dir evals/runs/2026-07-14-gpt-5.6-vague-causal-final-4d313c6
```

## Limitations

- The final score is one trial per case; it establishes a reproducible post-fix result but not a confidence interval.
- Sol/high and Sol/xhigh showed latency and output variance across diagnostics. Production use should retain an explicit OpenAI minimum timeout appropriate to the selected reasoning tier.
- Routes were pinned by the benchmark cases to test all tiers; this does not independently measure live classifier accuracy.
- Historical run directories are local ignored artifacts. The tracked case set, fixture, harness, pricing file, tests, and this report are sufficient to rerun the benchmark.

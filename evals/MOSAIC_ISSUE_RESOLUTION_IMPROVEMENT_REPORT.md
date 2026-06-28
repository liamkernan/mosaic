# Mosaic Issue-Resolution Improvement Report

Date: 2026-06-28

## Outcome

The P0 and highest-value P1 pipeline work is implemented and locally gated. A
fresh paid comparison did **not** improve the seven-case baseline: direct Sonnet
and production quality/advisor routing both scored 0/7, versus the source report's
2/7 (28.6%). The large-repository Storybook case initially scored 0/1 in both
modes. Its common failure exposed a deterministic validator defect; after a
test-first fix, direct Sonnet passed that case 1/1 with no scope violations.

No evaluation oracle was edited or weakened. Generated oracle edits, unrelated
protected-symbol changes, divergent repairs, and over-budget calls continued to
fail closed.

| Measure | Source baseline | Fresh direct Sonnet | Fresh quality/advisor |
| --- | ---: | ---: | ---: |
| Seven pinned cases passing | 2/7 (28.6%) | 0/7 | 0/7 |
| Backend cases passing | 2/4 | 0/4 | 0/4 |
| Frontend cases passing | 0/3 | 0/3 | 0/3 |
| Storybook before validator fix | Not available | 0/1 | 0/1 |
| Storybook after validator fix | Not available | **1/1** | Not rerun; budget preserved |
| Main-suite visible context | Not recorded | 26 files, 3.7/case | 27 files, 3.9/case |
| Post-fix Storybook scope | Not available | 7 loaded, 2 required files changed, 0 violations | Not rerun |

## Changes kept

### Evaluation integrity and cost control

- Each case runs in an isolated child process. Errors and five-minute timeouts
  become structured failures, usage is recovered, and later cases continue.
- Aggregate JSON and per-case plan, selected-context, change, validation,
  verification, diff, result, and usage artifacts are retained under
  `evals/runs/`.
- Hidden oracle paths are excluded from model context and immutable. Generated
  tests are limited to approved paths. Evaluation oracles were not modified.
- Direct, balanced, and quality presets reuse production routing. Repeated trials
  run round-robin and report raw trials, pass@1, and pass@k.
- Paid runs require an explicit cap and pricing table. Every request is checked
  against its maximum cost before it starts.
- Anthropic SDK 0.39.0 was upgraded to 0.106.0 because the old beta stream
  accumulator discarded `usage.iterations`. Telemetry now records and prices
  every Sonnet and Opus iteration separately and fails closed if an
  advisor-assisted response omits its advisor usage record.
- Advisor output is explicitly capped at 2,048 tokens per request.

### Scope, planning, and repair safeguards

- Promoted issues exclude sibling numbered issue specifications and reported
  tests from retrieval.
- Large-monorepo references remain package-scoped; the pinned Storybook context
  was reduced from 12 files to 7 without losing required implementation files.
- Protected Python, JavaScript, and TypeScript symbols reject unrelated behavior
  changes inside otherwise allowed files.
- Endpoint plans must cover route, service/data surface, tests, unit verification,
  and handler verification before generation.
- Structured edits get one bounded re-anchoring attempt. Multi-file candidates
  remain atomic.
- Repair loops reject increased error counts, new error categories, added scope,
  and failed-verification regressions.
- Frontend failures produce typed selector/action/expectation/actual repair
  requirements while retaining accessibility and keyboard guardrails.

### Measured validator correction

Both Storybook routes generated a new `.test.ts` module, but the validator treated
it as a browser asset and required an HTML `<script>` link. A regression test was
added first, reproduced the failure, and the static-asset check was narrowed to
exclude test modules. Ordinary orphaned `.js`/`.css` assets remain rejected.

The post-fix direct run passed:

- changed exactly `test-utils.ts` and `test-utils.test.ts`;
- loaded seven relevant package/convention files;
- reported zero scope violations and zero oracle changes;
- cost $0.359565.

## Paid evaluation results

### Seven pinned baseline cases

| Case | Direct Sonnet | Quality/advisor |
| --- | --- | --- |
| SLA sort | Failed: endpoint-path validation | Failed: endpoint-path validation |
| Idempotent external ref | Rejected attempted oracle edit | Failed: endpoint-path validation |
| Close audit event | Rejected attempted oracle edit | Failed: idempotency-path validation |
| Metrics endpoint | Rejected attempted oracle edit | Rejected unsafe oracle/test edit and missing import |
| Collections modal | Failed missing DOM hooks | Failed typed frontend assertions after repairs |
| Journal articles | Timed out after paid calls | Rejected pre-call by remaining budget |
| Product details | Failed asset/selector/test validation | Rejected pre-call by remaining budget |

Direct Sonnet made 20 calls and spent $1.359792. Quality routing made 18 calls
across five attempted cases, used the advisor in 17 calls, and spent $3.083666;
the final two cases were rejected before contacting Anthropic because their
maximum next-call cost exceeded the remaining quality cap.

### Storybook case

| Run | Result | Cost | Scope |
| --- | ---: | ---: | --- |
| Direct, before fix | 0/1 | $0.379983 | Candidate blocked by false positive |
| Quality/advisor, before fix | 0/1 | $1.066008 | Same false positive |
| Direct, after fix | **1/1** | $0.359565 | 2 required files changed; 0 violations |

Quality/advisor was not rerun after the validator fix because doing so was not
needed to validate the deterministic correction and would have reduced budget
safety margin.

## Token, model, and cost telemetry

Pricing snapshot: Sonnet 4.6 at $3/M input and $15/M output, Opus 4.8 at $5/M
input and $25/M output, with cache read/write multipliers represented in
`evals/anthropic-model-pricing-2026-06-28.json`. No cache tokens were reported.

| Metered run | Model | Input | Output | Cost |
| --- | --- | ---: | ---: | ---: |
| Seven-case direct | Sonnet 4.6 | 193,309 | 51,991 | $1.359792 |
| Seven-case quality | Sonnet 4.6 | 369,647 | 34,668 | $1.628961 |
| Seven-case quality | Opus 4.8 advisor | 227,736 | 12,641 | $1.454705 |
| Storybook direct, before fix | Sonnet 4.6 | 99,386 | 5,455 | $0.379983 |
| Storybook quality, before fix | Sonnet 4.6 | 154,081 | 3,559 | $0.515628 |
| Storybook quality, before fix | Opus 4.8 advisor | 102,256 | 1,564 | $0.550380 |
| Storybook direct, after fix | Sonnet 4.6 | 99,685 | 4,034 | $0.359565 |
| Aborted pre-upgrade quality call | Sonnet 4.6 | 4,808 | 959 | $0.028809 |

Known exact metered spend was **$6.277823**. One advisor iteration in the aborted
pre-upgrade call is the sole telemetry exception: SDK 0.39.0 discarded its
iteration detail. The run was stopped immediately. The identical post-upgrade
planning call measured that Opus iteration at $0.054620; using the matched input
and the full 2,048-token advisor output cap gives a $0.089595 proxy. Thus total
spend is estimated at $6.332443 and remains below $6.367418 under that proxy,
within the authorized $7 cap. No further paid calls were made.

## Deterministic verification

Final gates after all kept production changes:

```text
pnpm lint       PASS
pnpm typecheck  PASS
pnpm test       PASS: 237 tests, 3 skipped
pnpm build      PASS: all workspace packages
```

New regressions cover exact executor/advisor iteration telemetry, per-model
costing, fail-closed missing advisor usage, and exclusion of `.test.ts` modules
from static browser-asset linking while retaining the ordinary orphan-asset
guard.

Milestones added in this budgeted phase:

- `805df06` — track exact advisor evaluation cost
- `decdadd` — preserve advisor usage through streaming
- `48bfaec` — exclude test modules from static asset linking

## Remaining risks and next highest-value work

1. The generic endpoint validator is producing false negatives on otherwise
   plausible backend changes. Add case-derived deterministic regressions and
   make route checks framework-aware without weakening route coverage.
2. Models repeatedly attempted to edit reported oracle tests. Strengthen planner
   and generation path constraints so immutable paths are excluded from proposed
   changes, while retaining the hard post-generation rejection.
3. Frontend repair still spends heavily before converging or timing out. Preserve
   typed assertions but make initial DOM-hook selection consume the existing HTML
   contract directly.
4. Artifact capture should persist rejected candidate manifests and diffs before
   validation; current failed results can lose candidate-level scope detail even
   though selected context and usage remain available.
5. After those offline regressions pass, rerun the same seven cases with a new
   explicit budget. The target remains at least 6/7, all four backend cases, at
   least two frontend cases, zero oracle edits, zero unrelated changes, and no
   weakened safeguards.

The next highest-value task is framework-aware endpoint validation, because it
blocked multiple backend candidates in both routing modes and can be corrected
offline with deterministic tests before another paid evaluation.

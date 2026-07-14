# GPT-5.6 production-routing benchmark protocol — 2026-07-14

## Purpose

This benchmark measures whether Mosaic's real OpenAI classification and routing path selects the five safe GPT-5.6 routes without pinned planning or generation tiers. It is separate from the six-case end-to-end reliability benchmark, whose preclassified inputs intentionally pin those routes.

The frozen benchmark has 24 fresh cases: 18 development cases and six holdout cases. Each of the following outcomes has four cases overall, with three in development and one in holdout:

- trivial → Luna/high;
- simple → Terra/high;
- moderate-safe → Terra/xhigh;
- moderate-review-needed → Sol/high;
- complex-review-needed → Sol/xhigh;
- rejected-before-model → zero model calls.

The cases form 12 two-case boundary pairs. Each pair shares a repository scenario and split while changing one material factor: localized versus coordinated copy, static versus stateful accessibility, presentation versus component behavior, display versus persisted data, one existing path versus cross-layer behavior, contained versus malicious security work, or benign versus unsafe instructions.

The inputs file contains only information available to production classification: feedback identity, raw feedback, and repository file paths. Expected classifications, routes, review decisions, boundary factors, and rationales live in the separate expected file. Neither expected data nor sibling-case text may enter a model request.

## Frozen artifacts

- evals/gpt-5.6-routing-benchmark-2026-07-14.inputs.json
- evals/gpt-5.6-routing-benchmark-2026-07-14.expected.json
- tests/eval-gpt-5.6-routing-benchmark.test.ts

The commit that first adds these artifacts is the freeze point. Later production-routing changes must not relabel cases. If evidence shows a label is defective or ambiguous, report it under cause 1 and exclude it transparently rather than silently changing the frozen answer.

## Run order

1. Commit and push the frozen artifacts before any routing behavior change.
2. Run the development split through deterministic safety assessment and the exact production OpenAI path: Luna/high classification, conditional routed reclassification for non-trivial initial results, then final planning/generation selection.
3. Preserve raw classifications, every classification route, final route, call count, token use, cost, and latency in an ignored run directory.
4. Score route and review accuracy against the expected file only after model calls finish.
5. Classify every miss as exactly one primary cause:
   1. ambiguous or defective benchmark labeling;
   2. classifier or prompt failure;
   3. deterministic routing-policy failure;
   4. context-loading failure;
   5. provider or model configuration failure.
6. Make only fixes supported by multiple development failures. Add deterministic regression coverage for each corrected failure mode, checkpoint, and push.
7. Re-run the development split until routing is stable. Under-routing has higher severity than modest over-routing; routing everything to Sol is not acceptable.
8. Run the six-case holdout exactly once after fixes are selected. Do not tune or relabel from its results.
9. Only after routing accuracy is stable, run the separate five-safe-tier plus unsafe end-to-end holdout with no pinned planning or generation route and a hard maximum cost of $3.

## Scoring

Route accuracy requires the exact model and reasoning-effort pair. Review accuracy compares not-required versus required for moderate work; trivial and simple cases are recorded as not applicable, while unsafe cases must stop before classification. The confusion matrix uses these ordered outcomes:

1. rejected-before-model
2. trivial
3. simple
4. moderate-safe
5. moderate-review-needed
6. complex-review-needed

For safe routes, predicting a lower numbered model-capability tier than expected is under-routing; predicting a higher safe tier is over-routing. Safety rejection is scored separately so an unsafe request can never count as merely over-routed. Reports must give development and untouched holdout results separately and must retain all existing safety, containment, accessibility, protected-symbol, patch-size, and plan-completion guardrails.

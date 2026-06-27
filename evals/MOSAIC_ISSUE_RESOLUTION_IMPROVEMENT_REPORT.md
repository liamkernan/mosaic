# Mosaic Issue-Resolution Improvement Report

Date: 2026-06-27

## Result

The offline P0 and highest-value P1 work is complete. No paid model evaluation
was run because no numeric API budget was explicitly authorized. The last live
issue-resolution result therefore remains the Sonnet baseline of 2/7 (28.6%),
not a newly measured pass rate.

The rebuilt offline harness completed all seven pinned cases in dry-run mode,
produced a structured result and artifact bundle for every case, and spent $0
with zero model tokens. A dry-run pass confirms harness/retrieval readiness; it
does not claim that a generated fix passes its product oracle.

| Measure | Baseline | New measured result |
| --- | ---: | ---: |
| Live generated fixes passing | 2/7 (28.6%) | Not rerun; numeric budget required |
| Backend live passes | 2/4 | Not rerun |
| Frontend live passes | 0/3 | Not rerun |
| Aggregate cases reported after errors/timeouts | Could abort after case 1 | 7/7 dry-run results emitted |
| Oracle tests visible to generation | Yes | 0 oracle files visible |
| Exact local usage telemetry | Disabled | Enabled; dry-run totals are 0 tokens / $0 |
| SLA case visible context | 9 files in the pre-fix smoke measurement | 3 files (66.7% reduction) |
| All-case visible context | Not recorded | 26 files total, 3.7 per case average |

## Changes kept

### Trustworthy, reproducible evaluation

- Each case runs in its own child process and exceptions/timeouts become failed
  structured results instead of terminating the aggregate run.
- Timeout handling waits for process termination, escalates from `SIGTERM` to
  `SIGKILL`, and recovers persisted usage before the next case starts.
- Every run emits aggregate JSON. Every case persists its plan, selected-context
  manifest with reasons, change manifest, validation history, verification
  history, final diff, result, and local usage telemetry when model calls occur.
- Paid execution fails closed unless both `--max-cost-usd` and an explicit
  model-pricing JSON file are supplied.
- Local telemetry records phase, executor/advisor model IDs, input/output/cache
  tokens, latency, retries, advisor offered/used/unavailable state, and estimated
  cost without requiring production Redis persistence.
- Every request is conservatively authorized against its maximum output cost
  before it starts. Remaining budget is carried across sequential case workers.
- Direct, balanced, and quality presets reuse production routing functions;
  quality mode can offer the production advisor tool.

### Oracle and scope integrity

- Reported and smoke oracle tests are hidden from model context and immutable.
- Generated tests are restricted to approved `tests/generated/` paths.
- Promoted issues no longer retrieve sibling numbered issue specifications or
  their reported tests.
- Configured protected Python functions reject unrelated semantic changes even
  when the changed file itself is allowed. The four backend cases protect the
  known unrelated request-creation, sorting, closing, and metrics behaviors.

### Planner and edit recovery

- Endpoint plans are preflighted before generation. They must cover the public
  route, backing service/data surface, a test file, unit verification, and
  handler/route verification.
- An incomplete plan gets one constrained repair attempt. A still-incomplete
  plan fails instead of sending an invalid scope to generation.
- Safe new test paths remain in the plan even before the files exist; arbitrary
  missing source paths and unsafe paths are still rejected.
- Zero-match and multiple-match structured edits get one bounded re-anchoring
  attempt using current file excerpts. Multi-file candidates remain atomic.
- Existing accessibility validation was not weakened. Current generation and
  repair prompts continue to prefer native controls and require complete
  keyboard behavior for non-native interactive elements.
- Production and eval repair loops now classify repair progress as reduced,
  preserved, or increased. Repairs that add files, introduce validation/error
  categories, or increase error counts are rejected; failed verification
  repairs restore the prior candidate.
- Frontend assertion failures now emit compact JSON repair requirements with
  the action, selector alternatives, expected state/text/class/attribute/count,
  and actual observations. Focused repair maps existing generated elements to
  those selectors before redesigning and preserves unrelated page content.

## Deterministic verification

The final full local gate run passed:

```text
pnpm lint       PASS
pnpm typecheck  PASS
pnpm test       PASS: 229 tests, 3 pre-existing skips
pnpm build      PASS: all workspace packages
```

Focused regressions cover case exception continuation, timeout continuation,
JSON reporting, artifact persistence, immutable/hidden oracles, approved
generated-test paths, local usage observation, budget preauthorization, exact
token-cost calculation, sibling issue exclusion, endpoint plan repair,
protected-symbol scope violations, zero/multiple-match edit re-anchoring,
repair convergence rejection, and typed frontend selector adaptation.

Milestones:

- `a415666` — harden local fix evaluation harness
- `164b484` — tighten fix planning and scope recovery

## Baseline failures and current status

| Baseline failure | Offline response | Live status |
| --- | --- | --- |
| SLA repair wandered and retained a failing patch | Sibling context excluded; unrelated functions protected | Needs paid rerun |
| Passing backend patches changed unrelated behaviors | Protected-symbol scope oracle rejects the observed cross-fixes | Needs paid rerun |
| Metrics test fell outside planner scope | Endpoint preflight and one plan repair require unit/handler test work | Needs paid rerun |
| Collections repair missed DOM contract | Typed selector/state/count repair payload and existing-element adaptation added | Needs paid rerun |
| Journal cards violated keyboard accessibility | Strict validation and native-control generation contract preserved | Unresolved live |
| Product-details edit had zero exact matches | Bounded structured-edit re-anchoring added | Needs paid rerun |
| Aggregate run aborted | Per-case child isolation and structured failures added | Resolved offline |
| Usage/cost unknown | Local usage and conservative budget enforcement added | Resolved offline; live telemetry unproven |

## Cost and model telemetry

- Paid API calls made in this improvement run: 0
- Input tokens: 0
- Output tokens: 0
- Cache tokens: 0
- Estimated cost: $0.00
- Advisor calls: 0

The next live comparison must use identical pinned cases and separate output
directories for `--preset direct` and `--preset quality`. It must provide a
numeric `--max-cost-usd` and a reviewed pricing table for every executor and
advisor model. The harness will stop before starting a call whose conservative
maximum would exceed the remaining authorization.

## Remaining risks and next work

1. Authorize a numeric API budget and reviewed current model pricing, then run
   identical direct-Sonnet and production-quality/advisor trials. Until this is
   done, improvement over 2/7 is not proven.
2. Generalize protected-symbol semantic scope checks beyond the configured
   Python baseline cases.
3. Restore or replace the pinned medium/large repository case before drawing
   conclusions about production-scale retrieval or cost.
4. Run repeated trials after the first pinned comparison passes local gates;
   report raw trials, pass@1, scope violations, latency, advisor use, and cost.

The highest-value immediate step is the budget-authorized pinned comparison.
The success threshold remains at least 6/7 with all four backend cases, at
least two frontend cases, zero oracle edits, zero unrelated semantic changes,
and no weakened guardrails.

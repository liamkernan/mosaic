# GPT-5.6 offline reliability improvements — 2026-07-14

## Outcome

This follow-up fixes the reusable deterministic failures identified in the immutable 7/15 post-routing evaluation without rerunning, rescoring, or editing that evidence. No model provider was called, no routing policy changed, and no hidden oracle was exposed to generation or repair or modified.

Three independently green changes are now on `main`:

| Commit | Improvement |
| --- | --- |
| `a6b5193` | infer required production layers from visible requested behavior rather than generated-test paths or verification prose |
| `ae4e34e` | preserve visible request detail during generation and repair, remove false repair diagnostics, and stop identical-error repair loops |
| `ec3b799` | durably reserve worst-case call cost before provider transport and settle only the observed attempt |

## Causes and fixes

### Plan completion

The HTML-plus-test and dashboard-JavaScript-plus-test plans were correct. Generated test paths and phrases such as “browser” and “server” were being interpreted as production layers. Layer inference now uses the raw visible request and acceptance contract, and generated tests cannot satisfy or create production-layer requirements.

Strictness remains intact: regressions still reject a missing real frontend surface, a missing production JavaScript layer, and a vague request that conflicts with explicit full-stack acceptance criteria.

### Repair effectiveness

The eight retained repair attempts were not failures to carry the current candidate or choose a repair route. They all followed false deterministic feedback:

- an unchanged JavaScript companion was treated as a mandatory edit;
- client-only interaction wording invented backend work;
- generated-test wording invented full-stack work;
- a Python test method declaration was mistaken for an unqualified application call.

Preservation-only companion reasons no longer mandate a diff unless they contain an actual mutation instruction. Python method declarations no longer count as calls. Generation, retry generation, and validation repair now receive a deduplicated visible `summary + rawContent` request. Revalidation rejects an exact, order-insensitive repeat of nonempty errors as stalled instead of accepting another ineffective candidate.

A deterministic fake-response replay proves repair is anchored to the current candidate, stays within the planned file, fixes the visible behavior, preserves the original baseline, and passes both normal validation and plan-completion validation.

### Generated-test semantics

No benchmark-specific semantic rule was added. The two retained complex plans and generated tests explicitly asserted a visible export shape matching the fixture's implementation, while hidden verification rejected the resulting shape. The visible request did not unambiguously specify the missing structural distinction.

Carrying the full visible request into generation and repair improves general fidelity, but it cannot safely resolve this shape ambiguity. Hidden verification remains authoritative; the model-only limitation is intentionally documented instead of leaking the oracle, adding prompt bloat, or building a broad semantic-equivalence validator.

### Budget accounting

The two late trial denials remain correct fail-closed decisions. Roughly $1.11 remained before each denied Sol request, while the configured transport's real worst-case request cost was roughly $1.48. Pricing the logical 1,024-token request while sending the 49,152-token transport floor would have bypassed the cap and was not adopted.

The actual accounting defect was that authorization checked a maximum but retained no reservation. A canceled or crashed attempt without usage could therefore disappear from parent accounting. The harness now:

- creates an identified worst-case reservation and atomically persists it before transport starts;
- reports observed, outstanding reserved, and committed cost separately while retaining `totalCostUsd` as the observed-cost compatibility field;
- settles only the authorization ID attached to completed usage and releases that attempt's unused maximum;
- retains earlier retry, timeout, cancellation, or crash attempts as unknown-cost reservations;
- creates no reservation for rejected authorization;
- charges child results and interrupted/crashed children by committed cost, with observed-cost fallback for legacy snapshots;
- applies the same lifecycle to the routing benchmark and records provider-reported refusal usage.

Atomic temp-file replacement ensures a process killed during settlement leaves the earlier conservative reservation snapshot readable.

## Offline regressions

| Retained failure | Before | After |
| --- | --- | --- |
| HTML plus generated test | invented backend work | accepted with no backend requirement |
| dashboard JavaScript plus generated test | invented frontend and backend layers | accepted as client-only work |
| preservation-only companion | required an unrelated edit | unchanged companion is optional |
| generated Python test method | mistaken for missing application import | declaration is not treated as a call |
| unchanged validation errors | accepted as preserved progress | rejected as `stalled` |
| repaired candidate | historical attempts made no recovery | deterministic current-candidate repair passes both validators |
| completed expensive call | only observed usage was kept; no reservation lifecycle existed | completed attempt contributes exact observed cost, not its maximum |
| canceled/crashed call | could vanish from aggregate accounting | maximum remains committed and durable |
| late Sol authorization | denied by actual maximum | still denied; cap is not weakened |

## Preserved guardrails

The changes do not weaken authentication, quarantine, rate limits, security, accessibility, changed-path containment, protected-symbol checks, patch-size limits, model routing, validation, verification isolation, or hidden-oracle boundaries. Frozen cases, expected answers, fixtures, reports, protocols, pricing inputs, and run artifacts were not changed. The unsafe zero-call path and historical 7/15 score remain unchanged.

## Verification

All verification was offline:

```sh
pnpm build
pnpm lint
pnpm typecheck
pnpm typecheck:tests
pnpm test
(cd evals/fixtures/post-routing-reliability && python3 -m unittest tests.baseline.test_fixture_baseline)
pnpm exec vitest run \
  tests/pipeline-plan-completion-validator.test.ts \
  tests/pipeline-code-generator.test.ts \
  tests/pipeline-validator.test.ts \
  tests/pipeline-repair-progress.test.ts \
  tests/eval-local-fixes.test.ts \
  tests/llm-client.test.ts \
  -t 'retained HTML|retained dashboard|generated test stand|vague request suppress|production JavaScript layer|companion whose reason|repairs the current candidate|exact same errors|method declaration|atomically replaces|persists reservations|releases a completed call|unknown-cost call|successful retry|late-trial cap|committed cost|durable async authorization|successful OpenAI retry|refusal stop reason'
```

Results:

- build, lint, and both TypeScript checks passed;
- all 45 Vitest files passed: 428 tests passed and 3 Docker-gated tests were skipped;
- all 3 immutable fixture-native baseline tests passed;
- the named retained-failure replay passed 19/19 selected tests; 174 unrelated tests in those files were filtered out, not failed.

## Remaining limitation and smallest paid proof

The remaining limitations are explicit:

- the ambiguous complex export shape remains model-only;
- the historical order-sensitive simple HTML oracle remains unchanged and authoritative for that frozen score;
- an unknown-cost canceled attempt intentionally retains its maximum reservation because exact provider usage is unavailable, so later budget may be conservatively unavailable;
- offline regressions prove deterministic eligibility and repair mechanics, not a new model pass rate.

A smallest useful future paid proof is a separately frozen, non-holdout, one-trial run of three cases: the accessible-name case, the client-only details-state case, and the complex export case. Predeclare success as no invented production layers, no repair driven by the four removed false diagnostics, unchanged oracle isolation, and `committedCostUsd` never exceeding a cap calculated from pinned pricing and the actual transport minima. This proof was not run here and should not alter or rescore the historical artifacts.

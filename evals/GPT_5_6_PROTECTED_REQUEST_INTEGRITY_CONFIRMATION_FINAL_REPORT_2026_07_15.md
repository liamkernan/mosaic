# GPT-5.6 protected-request integrity confirmation and offline audit — 2026-07-15

## Outcome

One newly frozen, non-holdout two-case OpenAI proof was executed exactly once.
It remained valid: route accuracy was 2/2, raw pass@1 was 1/2,
repair-assisted success was 1/2, and final pass@1 was 2/2. All 11 outbound
request assertions passed before authorization and transport. No paid command
was rerun, and no additional paid call was made.

The bounded offline audit found one concrete defect, reproduced it with a
focused failing regression, and fixed it in one implementation attempt. No
second high-confidence defect remained, so the implementation loop stopped at
one production fix.

## Paid proof

| Case | Expected / actual route | Raw | Final | Outbound phases |
| --- | --- | --- | --- | --- |
| retained classification boundary | Terra / xhigh | pass | pass | classification ×2, planning, generation |
| fresh planner correction | Terra / xhigh | validator-detected failure | repair-assisted pass | classification ×2, planning, planner correction, generation, validation repair, verification repair |

Both candidate-authored generated tests executed independently and passed.
Visible validation and isolated hidden verification passed finally for both
cases. The fresh raw candidate omitted the exact
`GET /incident-owner/:incident_id` route surface; visible validation caught the
model omission, and the retained repair flow corrected it. There were no final
model, validator, repair, oracle, provider, budget, or integrity failures.

Exact telemetry:

| Case | Calls | Input | Output | Provider latency | Retries | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| retained boundary | 4 | 6,808 | 3,377 | 33,419 ms | 0 | $0.0616645 |
| fresh planner correction | 7 | 16,579 | 15,152 | 134,369 ms | 0 | $0.2573080 |
| total | 11 | 23,387 | 18,529 | 167,788 ms | 0 | $0.3189725 |

Wall-clock duration was 171,773 ms. Cache-read and cache-creation input tokens
were zero. All 11 reservations settled; observed and committed cost reconcile
at `$0.3189725`, outstanding reservation cost is `$0`, and there is no unknown
canceled-call exposure. The shared cap was `$3`.

Frozen configuration was OpenAI `quality`, one trial per case, no model or
reasoning override, a `49152` minimum from `frozen-proof`, automatic timeout
mode recorded as a null minimum from `frozen-proof`, and a 900,000 ms outer case
timeout. Frozen hashes remain:

- cases: `cbd489343710ff7b15af005bfefb7af486c23bcfbd1fe7e9ea9b406abfbd3b09`;
- fixture: `eaa5e749b1e48b1c583116b9bbc96dd001dfc725e6bd1df942efbd033a35e610`;
- pricing: `a7c270cd470262a73f72f3fa9adddf463b6fc27f5a0662aa5f7f0d36bee7e193`.

The immutable raw proof and proof report were committed at `99f7f6a` before any
production follow-up. `proof-summary.json` reconciles the aggregates and freezes
22 raw artifact hashes. Scans found no prompt payload, hidden-suite content,
secret, or API key in the selected evidence.

## Bounded offline audit

Only the four authorized surfaces were inspected:

1. Classification and downstream isolation: no defect found. Both paid
   classification passes and every later paid phase passed the fail-closed
   assertion; prompt-capture and fake-transport regressions remained green.
2. Plan completion and repair diagnostics: one defect found and fixed. Current
   usage records `validation-repair` and `verification-repair`, but
   `summarizeRepairAttempts` recognized only legacy combined phase names. The
   immutable fresh result therefore reported zero model attempts despite two
   repair calls.
3. Generated-test execution and visible-contract fidelity: no defect found.
   Changed Python tests run independently, zero-execution and all-skipped output
   fail closed, visible validation caught the missing route, and final generated
   coverage plus isolated verification passed.
4. Budget reservations and frozen configuration: no defect found. Frozen CLI
   precedence defeated dotenv defaults, all reservations settled, costs
   reconciled, the 49,152-token floor was used, automatic timeout provenance was
   correct, and the shared cap held.

The repair-count fix recognizes current `generation-repair`,
`validation-repair`, and `verification-repair` phases while retaining legacy
combined-phase behavior. Negative coverage proves that classification, initial
planning, planner correction, and initial generation are not miscounted as
post-generation repair attempts. Replaying the immutable fresh usage and
history through the fixed function yields exactly two model attempts and zero
deterministic attempts. The historical raw artifact remains unchanged and is
not rescored.

## Guardrails and commits

| Commit | Checkpoint |
| --- | --- |
| `385cedb` | implementation under paid test |
| `3fa7c13` | new cases, fixture snapshot, manifest, protocol, and green freeze |
| `99f7f6a` | immutable raw proof, machine summary, and paid proof report |
| `7057e62` | focused repair-attempt telemetry fix and regression |

The only production edit was the repair-attempt summarizer. Auth, quarantine,
rate limits, security, accessibility, containment, protected symbols, patch
limits, oracle isolation, routing, validation, generated-test execution, and
budget caps were not weakened. The four pre-existing untracked files were not
touched.

## Reproduction and final verification

The paid command is retained exactly once between `PAID_COMMAND_START` and
`PAID_COMMAND_END` in
`GPT_5_6_PROTECTED_REQUEST_INTEGRITY_PAID_CONFIRMATION_PROTOCOL_2026_07_15.md`.
It must not be run again.

Focused defect reproduction and verification:

```sh
pnpm exec vitest run tests/eval-local-fixes.test.ts
```

The added regression failed before the fix with `modelAttempts: 0` versus the
expected `2`; after the fix, all 50 focused tests passed. The bounded nine-file
audit suite passed 204 tests with 3 Docker-gated skips.

Final repository gates:

```sh
pnpm build
pnpm lint
pnpm typecheck
pnpm typecheck:tests
pnpm test
pnpm exec vitest run tests/eval-gpt-5.6-protected-request-integrity-paid-confirmation.test.ts
```

All seven builds, lint, and both typechecks passed. The second and final full
suite run passed all 51 files: 483 tests passed and 3 Docker-dependent tests
were skipped. The dedicated frozen proof passed 6/6, all 22 raw artifact hashes
matched, and no fixture cache directory changed its frozen hash. There were
exactly two complete-suite runs total.

## Remaining risks

- This is a two-case non-holdout confirmation, not a broad reliability score.
- The immutable proof correctly retains its inaccurate repair-attempt counter;
  only future summaries use the fix.
- Verification-repair evidence intentionally records the phase and outcome but
  not hidden failure details.
- Three Docker-dependent isolation tests remained skipped because Docker was
  unavailable; the normal degraded-isolation coverage passed.
- The telemetry fix received no new paid confirmation, because the proof was
  immutable and additional paid calls were prohibited.

Final review confirmed the tracked worktree is clean, only the four original
untracked files remain, and local `main` matches `origin/main` after the report
commit is pushed.

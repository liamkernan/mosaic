# GPT-5.6 protected-request boundary confirmation report — 2026-07-15

## Outcome

The separately frozen two-case confirmation is **invalidated for evaluation
integrity and is not scored**. The one permitted command stopped on request
assertion 1, during the first Luna classification attempt, because the local
outbound prompt contained a canonical protected path. The assertion rejected
before budget authorization and provider transport. The fresh second case was
not launched. No replacement command or rescore was performed.

This result does not confirm the protected-plan isolation fix and does not alter
the earlier invalidated proof or the immutable historical 7/15 evaluation. It
does confirm that the new transport-side boundary and batch-wide integrity stop
failed closed at a previously missed classification boundary.

## Frozen population and raw result

| Case | Expected implementation route | Raw/final result | Boundary evidence | Candidate evidence |
| --- | --- | --- | --- | --- |
| `protected-boundary-retained-moderate-safe-details-state` | Terra / xhigh | invalidated before classification completed | assertion 1, `classification`, Luna, rejected | no plan, generation, validation, verification, repair, changes, or generated test |
| `protected-boundary-fresh-planner-correction-incident-summary` | Terra / xhigh | unattempted by the integrity stop | no request started | none |

Route accuracy, raw pass@1, repair-assisted success, and final pass@1 are **not
evaluable**, rather than 0/2. No provider response or candidate existed. The
harness's mechanical partial summary is 0/1 because it records the stopped first
work item; it is not a valid proof score for the frozen two-case denominator.

No production layer was invented, none of the four forbidden false diagnostics
appeared, and there were no model, validator, repair, oracle, provider, or
budget failures. Those stages were not reached. The failure taxonomy is solely
`evaluation-integrity`.

## Boundary and isolation audit

The persisted assertion contains only sequence, phase, provider, model, and
status. No prompt, matched path, hidden content, or oracle failure detail is in
telemetry. A scan of the raw runtime artifacts created before diagnosis found no
protected canonical path or hidden-verification content; the later proof summary
names the locally detected policy category only as part of this diagnosis.

The rejection occurred locally before authorization:

| Metric | Value |
| --- | ---: |
| request assertions | 1 total; 0 passed; 1 rejected |
| authorizations / provider calls | 0 / 0 |
| input / output / cache-read / cache-creation tokens | 0 / 0 / 0 / 0 |
| retries / provider latency | 0 / 0 ms |
| observed / reserved / committed cost | $0 / $0 / $0 |
| unknown canceled-call exposure | none |

The primary cause is a policy mismatch before classification. The
classification file-tree builder partitions only paths and prefixes declared by
the case. The centralized outbound policy additionally protects
`tests/baseline/`. The frozen fixture contains that baseline directory, so its
path reached the local classification prompt and the independent boundary
caught it. No path or content reached OpenAI.

There is also a secondary frozen-environment discrepancy: although the command
unset `MOSAIC_OPENAI_MIN_TIMEOUT_MS`, run metadata recorded 420,000 ms because
workspace dotenv loading rehydrated the local setting. No transport occurred,
so this changed no request latency or cost, but it did not match the intended
route-only timeout floors and is part of the integrity record.

Any future work requires a new authorization and a new proof. It would need to
apply the centralized protected-path policy to classification file-tree context
and make the frozen timeout configuration immune to dotenv rehydration. This
run must not be rerun or replaced.

## Frozen inputs and commits

| Item | SHA-256 / commit |
| --- | --- |
| cases | `87ab380e84b584749a90dfff9d11ed866885a10782d3be43ed5136c7c41f3343` |
| fixture | `36298e84cce7c6da97bd75dd10f2b87aaae860ef1397b0d74810ab72fac8c3d4` |
| pricing | `a7c270cd470262a73f72f3fa9adddf463b6fc27f5a0662aa5f7f0d36bee7e193` |
| initial request-boundary implementation | `be8667c72774519388bfe4a94939fd325fd0d602` |
| batch integrity-stop implementation | `320f225b1a538c5dad45ab09c4715a637d9a1ce6` |
| final freeze and run | `bc1312cbf1f7f8c2fd31a717158ea0102ea6fb30` |

The run metadata captured no route/model/reasoning override, a 49,152-token
minimum output allocation, a 900,000 ms case timeout, one trial, and a shared
$3 cap. The single exact command is retained verbatim in `run-metadata.json` and
in `GPT_5_6_PROTECTED_REQUEST_BOUNDARY_CONFIRMATION_PROTOCOL_2026_07_15.md`.

Raw artifact hashes:

| Artifact | SHA-256 |
| --- | --- |
| `run-metadata.json` | `b74cb4c5e7a2a607002e8f8de60ff1c3cf815967d950f252b62ae7a8a647da6b` |
| `invalidation.json` | `c7f5185752234175c0208abe2428227f57c3f696586868f029bdb3499df96690` |
| `results.json` | `7b3ed1ace946f146c6f2e0c506074c219a5a6543dcc1b4463612b03d8571e35f` |
| first-case `usage.json` | `14f7f651001dae4926e87edf3f8c3da394944619d5ee86cc453c497627b7ab47` |
| first-case `result.json` | `629421bda3e1bc6b04e70d42f370ffd3a2ab887b72b6f2e37faa338f3d5a7262` |

## Commands and post-proof gates

Paid command: the single command between `PAID_COMMAND_START` and
`PAID_COMMAND_END` in the frozen protocol. It exited 1 after approximately 1.26
seconds and was not issued again.

Post-proof offline command:

```sh
pnpm build && pnpm lint && pnpm typecheck && pnpm typecheck:tests && pnpm test
```

Result: build, lint, both typechecks, and all 48 test files passed; 469 tests
passed and 3 Docker-dependent tests were skipped. The four pre-existing
untracked files remained untouched.

## Retained evidence

- Raw run directory: `evals/runs/2026-07-15-gpt-5.6-protected-request-boundary-confirmation-2-case-1x`
- Machine summary: `proof-summary.json`
- Stop record: `invalidation.json`
- Aggregate raw result: `results.json`
- Content-free request/cost telemetry: first-case `usage.json`

Only the selected raw proof artifacts, the machine summary, and this report are
committed. The absolute temporary-copy pointer is deliberately excluded.

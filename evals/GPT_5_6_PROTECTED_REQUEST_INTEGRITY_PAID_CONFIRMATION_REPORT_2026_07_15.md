# GPT-5.6 protected-request integrity paid confirmation — 2026-07-15

## Outcome

The newly frozen, non-holdout two-case proof is valid and completed. The one
permitted command was issued once from freeze commit `3fa7c13`; it was not
rerun, replaced, rescued, or rescored. Both automatic routes matched, raw
pass@1 was 1/2, one case succeeded through repair, and final pass@1 was 2/2.

All 11 outbound requests passed the protected-path assertion before budget
authorization and before OpenAI transport. No assertion rejected, no integrity
stop occurred, and the required planner-correction phase was observed. The
artifact scan found no prompt payload, hidden-suite content, API key, secret-like
material, or persisted protected content visible to the provider.

## Frozen result

| Case | Route | Request phases | Raw | Final | Generated test |
| --- | --- | --- | --- | --- | --- |
| retained classification boundary | Terra / xhigh | classification ×2, planning, generation | pass | pass | independently executed, pass |
| fresh planner correction | Terra / xhigh | classification ×2, planning, planner correction, generation, validation repair, verification repair | validator-detected raw failure | repair-assisted pass | independently executed, pass |

Metrics:

| Metric | Result |
| --- | ---: |
| expected-route accuracy | 2/2 |
| raw pass@1 | 1/2 |
| repair-assisted success | 1/2 |
| final pass@1 | 2/2 |
| independently executed generated tests | 2/2 |
| protected request assertions | 11 passed / 11 |

The fresh initial candidate omitted an implementation surface for the exact
`GET /incident-owner/:incident_id` path. Visible validation caught it; the
retained validation repair and isolated verification repair produced the final
passing candidate. Final failure taxonomy is empty. The only raw failure was a
model omission surfaced by the validator. There was no final model, validator,
repair, oracle, provider, budget, or evaluation-integrity failure.

## Telemetry

| Case | Calls | Input | Output | Provider latency | Retries | Observed / committed | Outstanding |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| retained boundary | 4 | 6,808 | 3,377 | 33,419 ms | 0 | $0.0616645 | $0 |
| fresh planner correction | 7 | 16,579 | 15,152 | 134,369 ms | 0 | $0.2573080 | $0 |
| total | 11 | 23,387 | 18,529 | 167,788 ms | 0 | $0.3189725 | $0 |

Wall-clock duration was 171,773 ms. Cache-read and cache-creation input tokens
were both zero. All 11 reservations settled; observed and committed cost
reconcile exactly at `$0.3189725`, below the shared `$3` cap. There is no unknown
canceled-call exposure.

`run-metadata.json` records provider `openai`, preset `quality`, no model or
reasoning override, frozen output minimum `49152` from `frozen-proof`, automatic
timeout mode as a null minimum from `frozen-proof`, a 900,000 ms outer case
timeout, the exact two case IDs, one trial, and the three frozen hashes.

## Integrity and retained evidence

The complete selected evidence is under
`evals/runs/2026-07-15-gpt-5.6-protected-request-integrity-paid-confirmation-2-case-1x`:

- `run-metadata.json` and `results.json`;
- per-case routing, selected-context metadata, sanitized plan, content-free
  request/usage/reservation telemetry, validation candidates/history,
  verification history, final change manifest/diff, and result;
- `proof-summary.json`, which records all raw artifact hashes and exact aggregate
  reconciliation.

Temporary-path pointer files are not selected proof artifacts. Raw artifact
hashes are frozen in `proof-summary.json`; aggregate raw hashes are
`4a546c348...403e02` for `results.json` and `11a428df...a5abc5` for
`run-metadata.json`.

One reporting discrepancy is retained rather than corrected: the fresh result's
`repairAttempts` counters say zero model attempts although usage records one
`validation-repair` and one `verification-repair` call. This does not change the
frozen score; it is an offline audit candidate after this proof commit.

## Freeze and exact commands

| Item | Value |
| --- | --- |
| implementation under test | `385cedb7bcf6122ed81cc5f4838dbdb6dcdb9410` |
| green proof freeze | `3fa7c1343e2febb1293caf3b918c880313adbb16` |
| cases SHA-256 | `cbd489343710ff7b15af005bfefb7af486c23bcfbd1fe7e9ea9b406abfbd3b09` |
| fixture SHA-256 | `eaa5e749b1e48b1c583116b9bbc96dd001dfc725e6bd1df942efbd033a35e610` |
| pricing SHA-256 | `a7c270cd470262a73f72f3fa9adddf463b6fc27f5a0662aa5f7f0d36bee7e193` |

The exact paid command is the single block between `PAID_COMMAND_START` and
`PAID_COMMAND_END` in
`GPT_5_6_PROTECTED_REQUEST_INTEGRITY_PAID_CONFIRMATION_PROTOCOL_2026_07_15.md`.
It was issued once and must not be issued again.

Preflight commands and results are frozen in that protocol: all seven builds,
6/6 proof-freeze checks, 51/51 prompt-capture tests, 92/92 fake-transport/config
tests, lint, both typechecks, and the full 51-file suite passed with 482 tests
passed and 3 Docker-gated skips. No paid call occurred before freeze push.

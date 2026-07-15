# GPT-5.6 protected-request boundary integrity fix report — 2026-07-15

## Outcome

The two offline integrity defects documented in the invalidated protected-request
boundary confirmation are fixed and covered by deterministic regressions. No
paid or live model call was made, and the invalidated proof was not rerun,
rescored, replaced, or edited.

## Causes and fixes

1. Classification isolation: the evaluation harness built classification file
   trees with a case-local oracle partition, while the outbound boundary used
   the broader centralized policy, including `tests/baseline/`. Classification
   also lacked one policy-aware path for model-returned summaries and relevant
   files.

   The classifier and both OpenAI classification passes now use the existing
   `ModelVisiblePlanPathPolicy` and its canonical sanitizer. Raw feedback prose,
   file trees, returned summaries, returned relevant files, selected repository
   context, reference context, and planned-file context are sanitized through
   that policy. Slash, dotted-module, Windows, mixed-case, and nested-prose
   references are removed or generalized; generated-test paths, ordinary source
   paths, and near misses remain visible. No case-specific production rule was
   added.

2. Frozen configuration: dotenv populated `process.env` before the harness read
   evaluation settings, so an unset timeout was indistinguishable from a dotenv
   default and silently became 420,000 ms.

   Configuration loading now records whether a value came from the startup
   process environment or dotenv. The frozen evaluation resolver accepts
   explicit frozen minimum-output and minimum-timeout settings, forwards them to
   child trials, prevents dotenv-derived evaluation overrides from taking effect
   in frozen mode, and records source and value in `run-metadata.json`. Frozen
   routes also use the frozen route selection instead of dotenv model/reasoning
   overrides. Credentials may still come from dotenv, and ordinary non-frozen
   local evaluations preserve existing dotenv behavior.

## Configuration precedence

| Priority | Source | Frozen behavior |
| ---: | --- | --- |
| 1 | frozen proof CLI configuration | authoritative, including `disabled` output minimum or `automatic` timeout mode |
| 2 | explicit startup process environment | used when the frozen proof does not set that value |
| 3 | dotenv default | used for normal local evaluations; ignored for frozen evaluation overrides |
| 4 | automatic tier timeout floor | fallback when no effective timeout minimum exists |

Automatic floors remain centralized in the LLM client: Sol/high is 300,000 ms
and Sol/xhigh is 480,000 ms. Run metadata records the effective minimum source
and value plus the tier-floor source/value map.

## Offline boundary coverage

Deterministic prompt-capture regressions cover baseline and oracle prefixes,
the exact protected fixture, every requested normalization variant, allowed
generated tests and ordinary source files, and near-miss paths across both
classification passes.

The fake-transport end-to-end regression issues seven accepted requests:

1. Luna classification
2. routed classification
3. initial planning
4. planner correction
5. generation
6. validation repair
7. verification repair

For each request, the protected-path assertion passes before authorization and
before fake provider transport, and the captured transport payload is clean. A
deliberately unsafe eighth request is rejected by the fail-closed assertion and
adds zero provider calls, zero reservations, and zero usage entries.

## Commits

| Commit | Change |
| --- | --- |
| `a2163c90f18555dda3ffa158187f8f0359f1086e` | centralized classification isolation and prompt-capture regressions |
| `260a8bbafac233f2a92a6a6a8020810d63401db0` | deterministic frozen configuration, provenance, and metadata |
| `fdeea0dd1a9fcc16c820c50f42ab36fa4c1322bc` | offline fake-transport end-to-end boundary regression |

## Verification

Commands completed successfully:

```sh
pnpm build
pnpm lint
pnpm typecheck
pnpm typecheck:tests
pnpm test
pnpm exec vitest run tests/eval-gpt-5.6-protected-request-boundary-confirmation.test.ts
```

Results: all seven workspace builds passed; lint and both typechecks passed; all
50 test files passed with 476 tests passed and 3 Docker-dependent tests skipped;
the dedicated frozen confirmation suite passed all 6 tests.

Frozen inputs remain unchanged:

| Input | SHA-256 |
| --- | --- |
| cases | `87ab380e84b584749a90dfff9d11ed866885a10782d3be43ed5136c7c41f3343` |
| fixture | `36298e84cce7c6da97bd75dd10f2b87aaae860ef1397b0d74810ab72fac8c3d4` |
| pricing | `a7c270cd470262a73f72f3fa9adddf463b6fc27f5a0662aa5f7f0d36bee7e193` |

Auth, quarantine, rate-limit, security, accessibility, containment, patch-size,
protected-symbol, oracle, routing, validation, and budget guardrails were not
weakened. The four pre-existing untracked files remained untouched.

## Structure of a future separately frozen two-case proof

A future proof requires separate authorization and must be newly frozen. It
should:

1. create a new two-case manifest, fixture snapshot, protocol, output directory,
   and recorded SHA-256 values at the then-current code commit;
2. retain one regression case for the classification boundary and add one fresh
   independently sensitive case that requires planner correction;
3. complete offline baseline, hidden-oracle sensitivity, prompt-capture,
   fake-transport, full-gate, and frozen-hash checks before authorizing transport;
4. pin provider, quality preset, cases, pricing, one trial, case timeout, cost cap,
   `--frozen-openai-min-output-tokens 49152`, and
   `--frozen-openai-min-timeout-ms automatic` in one exact frozen command;
5. preserve the fail-closed assertion and batch-wide integrity stop, with no
   retry, rescue, replacement run, or rescore after an integrity failure; and
6. report route accuracy, raw pass@1, repair-assisted result, final pass@1,
   request/reservation/usage telemetry, cost, commits, hashes, and honest failure
   classification only if the proof remains valid.

This report defines that structure only. It does not create or run the proof.

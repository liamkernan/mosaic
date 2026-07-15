# GPT-5.6 protected plan-path isolation fix — 2026-07-15

## Outcome

The evaluation-integrity failure retained in `GPT_5_6_OFFLINE_RELIABILITY_PAID_CONFIRMATION_REPORT_2026_07_15.md` is fixed entirely offline. No paid proof was rerun, no provider was called, and no historical case, fixture, label, route, pricing file, oracle, run artifact, report, or score was changed.

The failure was broader than one checklist sentence: plan sanitization lived in the eval helper, ran only after planning had finished, and rewrote protected references only when they were exact required-file targets. Incidental checklist prose such as `Do not modify tests/baseline/ or tests/oracle/.` could therefore reach generation. A rejected plan could also reach the planner's own correction request before the eval helper saw it.

## Centralized boundary

`packages/pipeline/src/implementation-plan-sanitizer.ts` now owns one model-visible path policy and one recursive plan sanitizer. The policy is applied at all downstream model boundaries:

- the planner sanitizes its first parsed plan before validation and before including a rejected plan in a planning-repair request;
- generation sanitizes the accepted plan again before keyword selection and prompt formatting;
- validation and verification repair sanitize the plan and repair-visible error text before prompt formatting;
- protected relevant files, file-tree entries, and protected current changes are excluded defensively at those boundaries;
- the eval harness supplies the same policy to planning, initial generation, generation repair, and focused check repair.

The sanitizer canonicalizes slash paths, dotted Python modules, Windows separators, and casing variants. It recursively sanitizes every string-valued plan field, including future or nested summaries, required-file reasons, acceptance criteria, implementation checklists, verification checklists, and verification commands.

Protected references become the useful generic phrase `immutable verification tests`. Protected executable commands are removed and replaced by a generic verification-boundary checklist item when the plan otherwise lacks one. A protected required test is replaced by collision-safe independent coverage under the approved generated-test prefix. Newly proposed non-protected tests are relocated to the approved prefix while retaining their useful filename and reason.

The same canonical comparison now backs oracle context partitioning, verification-command partitioning, generated-path containment, and immutable-test relocation. Mixed-case and Windows-separated path variants therefore cannot be prompt-safe but write-unsafe, or vice versa.

## Regressions

Positive coverage proves that all of these are removed before a downstream model call:

- `tests/oracle/test_secret.py`;
- `tests.oracle.test_secret`;
- `Tests\Oracle\Test_Secret.py`;
- `TESTS/BASELINE/` and `TESTS.BASELINE`;
- an exact protected file outside the test tree;
- protected references in summaries, reasons, required files, acceptance criteria, checklist prose, commands, file trees, relevant-file context, current changes, and repair errors.

The exact sentence retained by the invalidated proof has a dedicated regression and becomes `Do not modify immutable verification tests.`

Negative coverage proves that the sanitizer preserves:

- approved `tests/generated/` paths and commands;
- ordinary source paths such as `src/oracle-client.ts`;
- generic prose about an oracle or unit tests;
- near-miss paths such as `tests/oracle-helper/` and `tests/baseline_data/`;
- visible implementation intent and independent generated-test coverage.

Prompt-capture regressions verify the absence of protected paths and hidden file contents in initial planning, planner correction, generation, and validation/verification repair requests. Existing auth, quarantine, rate limits, routing, validation, accessibility, security, patch limits, protected-symbol checks, generated-test execution, hidden verification, and cost-reservation behavior are unchanged.

## Verification

The required repository gates for this change are:

```sh
pnpm build
pnpm lint
pnpm typecheck
pnpm typecheck:tests
pnpm test
```

Focused isolation coverage is:

```sh
pnpm exec vitest run \
  tests/pipeline-implementation-plan-sanitizer.test.ts \
  tests/pipeline-implementation-planner.test.ts \
  tests/pipeline-code-generator.test.ts \
  tests/eval-local-fixes.test.ts \
  tests/pipeline-prompts.test.ts
```

Final offline results:

- build, lint, and both TypeScript checks passed;
- focused isolation coverage passed 112/112 tests;
- the full suite passed all 47 files: 440 tests passed and 3 Docker-gated tests were skipped;
- the frozen paid-confirmation manifest and input-hash checks passed 4/4, and the fixture remained free of `__pycache__` directories after the full suite.

The fixture-native oracle subprocess sets `PYTHONDONTWRITEBYTECODE=1` so it cannot race the frozen directory-hash test by creating transient cache files during the concurrent full suite. This changes no fixture, oracle, assertion, or historical outcome.

## Recommended future confirmation structure

Do not reuse or rescore the invalidated run. If a paid confirmation is useful later, create a new separately labeled non-holdout manifest and protocol in a new commit before any provider call. The smallest defensible structure is:

1. Freeze the implementation commit, retained moderate-safe details-state case, one adversarial planner-repair case, expected automatic routes, fixture hashes, protected-path policy, pricing, output-token minimum, timeout floors, and a small shared cap.
2. Add a transport-side preauthorization assertion that scans every outbound planning, planner-repair, generation, and repair request for canonical protected-path variants and aborts before transport if one is present.
3. Run exactly one trial per frozen case with production classification and routing, no model or reasoning override, no extra cases, and no reruns.
4. Predeclare success as zero protected references in every outbound request, correct routes, independently executed generated tests, passing visible and hidden verification, and committed cost below the cap.
5. Persist the request-boundary isolation assertions, routes, validation, verification, repair, usage, reservations, latency, and cost artifacts without storing secrets or hidden oracle contents.
6. Stop and invalidate immediately on any integrity violation. A failed or interrupted result remains evidence and must not trigger an immediate replacement run.

This recommendation is structure only. No future confirmation manifest, paid command, or replacement score is created by this fix.

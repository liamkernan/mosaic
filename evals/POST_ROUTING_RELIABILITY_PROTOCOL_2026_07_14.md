# Mosaic post-routing reliability follow-up protocol — 2026-07-14

## Purpose and phase gate

This follow-up fixes two post-routing reliability defects without changing the
historical GPT-5.6 score, weakening an oracle, or tuning routing from a scored
solution trial. Work proceeds in this fixed order:

1. reproduce the visibility false negative and malformed generated test
   offline;
2. commit this protocol before changing runtime behavior;
3. implement the smallest reusable fixes and deterministic regressions;
4. pass focused and repository-wide offline checks;
5. freeze and commit a fresh repeated-evaluation fixture, cases, expected
   outcomes, and run protocol;
6. make paid calls once, with three predeclared trials per safe case and a hard
   aggregate cost cap of $5;
7. retain and report every result without tuning and rerunning it as untouched.

The existing one-shot result remains **5/6 raw**. The following historical
inputs and evidence are read-only for this follow-up:

- `evals/GPT_5_6_UNPINNED_ROUTING_REPORT_2026_07_14.md` (Git object
  `993d37b1634ef601b6cf5b41920d91e2b308530f`);
- `evals/gpt-5.6-unpinned-e2e-holdout-2026-07-14.json` (Git object
  `7d1b8f341006a682444685a823450c1e82c29f9d`);
- `evals/fixtures/routing-holdout/` (Git tree
  `b414cd1ff1383015e80e30c64fade023600ef418`);
- `evals/runs/2026-07-14-gpt-5.6-unpinned-e2e-final-dc83d1c/` and every
  contained artifact.

They must not be edited, rerun, rescored, or used to replace the retained raw
failure. The four files already untracked at the start of this follow-up are
also out of scope and must remain untouched:

- `evals/SONNET_LOCAL_FIX_EVALUATION_REPORT.md`;
- `evals/gpt-5.6-fresh-completeness-cases-2026-07-11.json`;
- `evals/gpt-5.6-tier-routing-cases.json`;
- `evals/openai-model-pricing-2026-07-03.json`.

## Frozen offline reproductions

The visibility defect was reproduced against the current helper before any
production edit:

```sh
pnpm exec tsx -e 'import { JSDOM } from "jsdom"; import { frontendElementIsOpen } from "./scripts/eval-local-fixes-support.ts"; const dom = new JSDOM(`<section id="panel" hidden></section>`); const panel = dom.window.document.querySelector("#panel"); if (!panel) throw new Error("missing panel"); panel.hidden = false; console.log(JSON.stringify({hasHiddenAttribute: panel.hasAttribute("hidden"), hiddenProperty: panel.hidden, reportedOpen: frontendElementIsOpen(panel)})); dom.window.close();'
```

Pre-fix output:

```json
{"hasHiddenAttribute":false,"hiddenProperty":false,"reportedOpen":false}
```

The retained generated test was reproduced only in an isolated copy of the
historical fixture:

```sh
tmp=$(mktemp -d /tmp/mosaic-generated-test-repro.XXXXXX)
cp -R evals/fixtures/routing-holdout "$tmp/repo"
(cd "$tmp/repo" && \
  git apply /Users/liamkernan/Documents/automatedfeedback/evals/runs/2026-07-14-gpt-5.6-unpinned-e2e-final-dc83d1c/e2e-unpinned-moderate-safe-sort-state/final.diff && \
  uv run --with pytest==8.4.1 python -m pytest -q \
    tests/generated/test_sort_panel_accessibility.py)
rm -rf "$tmp"
```

Pre-fix result: one test passed and the interaction test failed while loading
`script.js` with
`TypeError: Cannot read properties of null (reading 'addEventListener')` at
`#saveFilterButton`. The generated DOM fixture omitted boot-time dependencies.
The historical case ran only its baseline command, so the changed generated
test was not executed and its initial verification history was empty.

## Deterministic visibility cases

Open state is evidence-based, not equivalent to DOM existence. The fix must
preserve the following outcomes:

| Case | Before action | After action | Required result |
| --- | --- | --- | --- |
| Hidden property opens generic element | `element.hidden === true` | `element.hidden = false` | open |
| Hidden attribute removal opens generic element | `hidden` present | `removeAttribute("hidden")` | open |
| ARIA opens element | `aria-hidden="true"` | `aria-hidden="false"` | open |
| ARIA closes element | `aria-hidden="false"` | `aria-hidden="true"` | closed |
| Native dialog opens | no `open` attribute | `showModal()` or `open` present | open |
| Native dialog closes | `open` present | `close()` or `open` absent | closed |
| Supported class opens element | no supported open class | add `is-open`, `is-visible`, `active`, or `modal-overlay--open` | open |
| Supported class closes element | supported open class present | remove the class | closed |
| Contradictory hidden state | `hidden` remains present | `aria-hidden="false"`, open class, or dialog `open` also present | closed |
| Contradictory ARIA state | `aria-hidden="true"` remains present | open class or dialog `open` also present | closed |
| Mere existence | generic element was never hidden and has no explicit open signal | unchanged after action | closed |
| Ambiguous generic `open` attribute | non-dialog merely has `open` | unchanged after action | closed |

The implementation may compare a compact pre-action snapshot with the
post-action state. It must not infer that every generic element without a
`hidden` attribute is open. Native-dialog semantics, accessibility checks,
selector contracts, containment, and the existing supported open classes stay
intact.

## Deterministic generated-test cases

Every candidate-added regression test must be selected by an allowlisted
verification command that targets the changed test under its intended runner.
It must run in the isolated candidate copy before the solution can pass.

| Case | Candidate test | Required result |
| --- | --- | --- |
| Complete frontend fixture | supplies every DOM node queried during script boot and exercises the requested interaction | command executes the test and passes |
| Incomplete frontend fixture | omits one unrelated but boot-required DOM node | command executes and fails with a concise boot-time dependency error |
| Syntax error | contains invalid Python, JavaScript, or TypeScript syntax | verification fails; the test is never counted as coverage |
| Independent execution | passes only when another test or hidden oracle has initialized state | direct changed-test command fails |
| Existing suite plus changed test | broad baseline command does not explicitly select the new test | the changed test is still selected and run |
| Failing generated test | application change is otherwise correct | solution remains failed until the test and implementation pass together |

Generated-test failures may enter the existing repair path only as bounded,
actionable verification output. Hidden fixture-native oracle paths, source,
expected values, and trace details must not enter model-visible context. A
repair must preserve the generated test and its meaningful assertions; it may
not delete, skip, trivialize, or silently ignore the test.

## Fresh live evaluation rules

A separate tracked freeze commit must be pushed before any paid call. It will
contain a new fixture, one fresh accepted case for each automatic production
tier, one deterministically rejected unsafe case, expected routes/outcomes,
hidden fixture-native oracles, and the exact command. No old holdout input,
fixture, expected answer, artifact, or report will be reused as fresh evidence.

The five accepted cases run in round-robin order for exactly three independent
trials each. Code, prompts, labels, fixtures, commands, oracles, and routes are
immutable from the first scored call through the last. The unsafe case runs
once, before model work, and must record zero calls. There are no model or
reasoning overrides; classification and routing use the production path and
automatic tier-specific timeout floors.

All paid work requires the dated pricing fixture, complete usage observation,
separate case/trial artifacts, and one aggregate `--max-cost-usd 5`
authorization. The output directory must be new and fail closed if it already
exists. Run metadata must persist the code commit and hashes of the cases,
fixture, expected outcomes, pricing fixture, cap, command, and relevant routing
environment. `MOSAIC_OPENAI_MODEL` and `MOSAIC_OPENAI_REASONING_EFFORT` must be
unset and rejected if present. A failed, timed-out, or interrupted trial is
retained. No result may be tuned against and then rerun under the same
frozen-evaluation claim. The unsafe result must persist an explicit zero-call,
zero-token, zero-cost usage record.

The final report records:

- exact route accuracy across all 15 safe trials and the unsafe decision;
- raw pre-repair solution success, trial-one pass@1, repair-assisted success,
  and consistency (`3/3` repeatable, `2/3` mixed, `0–1/3` unreliable) per case;
- validation versus verification failures and repairs per case;
- calls, latency, input/output/cache tokens, retries, and cost per trial and in
  aggregate;
- unsafe-request model-call count;
- every failure under exactly one primary category: benchmark/oracle defect,
  deterministic validator defect, generated-test quality defect, model
  solution-quality failure, repair-application failure, or provider/latency/
  harness failure.

## Guardrails and completion gates

No step may weaken or bypass auth, quarantine, rate limits, security,
accessibility, containment, patch-size, protected-symbol, routing,
plan-completion, or verification isolation. No hidden oracle is edited or
exposed. No benchmark-specific selector, copy, or prompt exception is allowed.
Secrets, temporary run directories, and unrelated changes are never committed.

Before the capped evaluation, focused regressions and the relevant broader
checks must pass. Final completion requires `pnpm build`, `pnpm lint`,
`pnpm typecheck`, `pnpm typecheck:tests`, the complete `pnpm test` suite, and
fixture-native backend and frontend verification, followed by the frozen capped
evaluation and a tracked report retaining all outcomes.

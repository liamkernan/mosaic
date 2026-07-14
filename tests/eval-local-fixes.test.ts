import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EvalBudget,
  EvalCaseExecutionError,
  DEFAULT_EVAL_CASE_TIMEOUT_MS,
  assertGeneratedPathsAllowed,
  buildChangedPythonTestCommand,
  calculateUsageCostUsd,
  calculateUsageIterationsCostUsd,
  createEvalTrialRuns,
  estimateMaximumAdvisorCallCostUsd,
  formatFrontendRepairRequirement,
  frontendElementHasDialogSemantics,
  frontendElementIsOpen,
  partitionVisibleContext,
  relocateGeneratedTestsFromImmutablePaths,
  sanitizePlanForImmutablePaths,
  runEvalCaseBatch,
  summarizeRepairAttempts,
  summarizeEvalTrials,
  validateAllowedChangedPaths,
  validateUnchangedSymbols,
  validateUnchangedSymbolsWithAllowedLines,
  validateUnchangedPythonSymbols,
  writeCaseArtifacts,
  writeEvalReport
} from "../scripts/eval-local-fixes-support.js";
import { createTempDirTracker } from "./helpers/temp-dirs.js";

describe("local fix evaluation harness", () => {
  const tempDirs = createTempDirTracker();

  afterEach(async () => {
    await tempDirs.cleanup();
  });

  it("uses provider-aware routes for every evaluation client call", async () => {
    const source = await readFile("scripts/eval-local-fixes.ts", "utf8");

    expect(source).not.toMatch(/createEvalLlmClient\(\s*(?:planningModel|generationModel)/);
    expect(source).not.toContain("advisorTool));");
    expect(source).toContain("routes.planning");
    expect(source).toContain("routes.generation");
  });

  it("reuses the accepted plan for focused check repair without replanning", async () => {
    const source = await readFile("scripts/eval-local-fixes.ts", "utf8");
    const checkRepairStart = source.indexOf("if (options.generate && implementationPlan && checkErrors.length > 0)");
    const checkRepairEnd = source.indexOf("errors.push(...checkErrors)", checkRepairStart);
    const checkRepair = source.slice(checkRepairStart, checkRepairEnd);

    expect(checkRepair).toContain('"check-repair"');
    expect(checkRepair).toContain("implementationPlan,");
    expect(checkRepair).toContain("repoContext,\n      changes,\n      checkErrors");
    expect(checkRepair).not.toContain("new ImplementationPlanner");
    expect(checkRepair).not.toContain("check-repair-planning");
    expect(checkRepair).toContain('stage: "check-repair-no-candidate"');
  });

  it("uses the source-of-truth seven-minute case timeout", () => {
    expect(DEFAULT_EVAL_CASE_TIMEOUT_MS).toBe(420_000);
  });

  it("records a thrown case and continues with later cases", async () => {
    const runCase = vi.fn(async (id: string) => {
      if (id === "case-1") {
        throw new Error("candidate crashed");
      }
      return { id, passed: true };
    });

    const results = await runEvalCaseBatch(["case-1", "case-2", "case-3"], {
      timeoutMs: 100,
      runCase
    });

    expect(results).toEqual([
      expect.objectContaining({ id: "case-1", passed: false, outcome: "error", errors: ["candidate crashed"] }),
      expect.objectContaining({ id: "case-2", passed: true, outcome: "completed" }),
      expect.objectContaining({ id: "case-3", passed: true, outcome: "completed" })
    ]);
    expect(runCase).toHaveBeenCalledTimes(3);
  });

  it("records a timeout without terminating aggregate reporting", async () => {
    const runCase = vi.fn((id: string, signal: AbortSignal) => {
      if (id !== "case-1") {
        return Promise.resolve({ id, passed: true });
      }
      return new Promise<{ id: string; passed: boolean }>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    const results = await runEvalCaseBatch(["case-1", "case-2"], {
      timeoutMs: 5,
      runCase
    });

    expect(results[0]).toEqual(expect.objectContaining({
      id: "case-1",
      passed: false,
      outcome: "timeout"
    }));
    expect(results[1]).toEqual(expect.objectContaining({
      id: "case-2",
      passed: true,
      outcome: "completed"
    }));
  });

  it("preserves recorded case details when an isolated run fails", async () => {
    const results = await runEvalCaseBatch(["case-1"], {
      timeoutMs: 100,
      runCase: async () => {
        throw new EvalCaseExecutionError("candidate stopped", {
          artifactPath: "evals/runs/case-1",
          usage: { totalCostUsd: 0.25 },
          repairAttempts: { modelAttempts: 1, deterministicAttempts: 0, totalAttempts: 1, stages: [] }
        });
      }
    });

    expect(results[0]).toEqual(expect.objectContaining({
      id: "case-1",
      passed: false,
      outcome: "error",
      errors: ["candidate stopped"],
      artifactPath: "evals/runs/case-1",
      usage: { totalCostUsd: 0.25 },
      repairAttempts: { modelAttempts: 1, deterministicAttempts: 0, totalAttempts: 1, stages: [] }
    }));
  });

  it("writes a machine-readable result for every selected case", async () => {
    const outputDir = await tempDirs.create("mosaic-eval-report-");
    const outputPath = join(outputDir, "results.json");
    const results = [
      { id: "case-1", passed: false, outcome: "error" as const, errors: ["boom"] },
      { id: "case-2", passed: true, outcome: "completed" as const, errors: [] }
    ];

    await writeEvalReport(outputPath, results, { startedAt: 10, finishedAt: 20 });

    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual({
      startedAt: 10,
      finishedAt: 20,
      results
    });
  });

  it("creates round-robin trial runs with isolated identities", () => {
    expect(createEvalTrialRuns(["case-a", "case-b"], 3)).toEqual([
      { caseId: "case-a", trial: 1, runId: "case-a--trial-1" },
      { caseId: "case-b", trial: 1, runId: "case-b--trial-1" },
      { caseId: "case-a", trial: 2, runId: "case-a--trial-2" },
      { caseId: "case-b", trial: 2, runId: "case-b--trial-2" },
      { caseId: "case-a", trial: 3, runId: "case-a--trial-3" },
      { caseId: "case-b", trial: 3, runId: "case-b--trial-3" }
    ]);
    expect(createEvalTrialRuns(["case-a"], 1)).toEqual([
      { caseId: "case-a", trial: 1, runId: "case-a" }
    ]);
  });

  it("summarizes raw trials, pass@1, and pass@k by pinned case", () => {
    const summary = summarizeEvalTrials([
      { id: "a--trial-1", caseId: "a", trial: 1, passed: false, outcome: "completed", errors: ["failed"] },
      { id: "b--trial-1", caseId: "b", trial: 1, passed: true, outcome: "completed", errors: [] },
      { id: "a--trial-2", caseId: "a", trial: 2, passed: true, outcome: "completed", errors: [] },
      { id: "b--trial-2", caseId: "b", trial: 2, passed: false, outcome: "completed", errors: ["failed"] }
    ]);

    expect(summary).toEqual({
      totalTrials: 4,
      passedTrials: 2,
      trialPassRate: 0.5,
      passAt1: { passedCases: 1, totalCases: 2, rate: 0.5 },
      passAtK: { passedCases: 2, totalCases: 2, rate: 1 },
      cases: [
        { caseId: "a", passedTrials: 1, totalTrials: 2, passAt1: false, passAtK: true },
        { caseId: "b", passedTrials: 1, totalTrials: 2, passAt1: true, passAtK: true }
      ]
    });
  });

  it("rejects oracle edits while allowing approved generated-test paths", () => {
    expect(() => assertGeneratedPathsAllowed(
      ["src/service.py", "tests/oracles/test_sla.py"],
      {
        oraclePaths: ["tests/oracles/test_sla.py"],
        generatedTestPathPrefixes: ["tests/generated/"]
      }
    )).toThrow("immutable oracle");

    expect(() => assertGeneratedPathsAllowed(
      ["src/service.py", "tests/generated/test_sla_extra.py"],
      {
        oraclePaths: ["tests/oracles/test_sla.py"],
        generatedTestPathPrefixes: ["tests/generated/"]
      }
    )).not.toThrow();

    expect(() => assertGeneratedPathsAllowed(
      ["tests/test_sla.py"],
      {
        oraclePaths: ["tests/oracles/test_sla.py"],
        generatedTestPathPrefixes: ["tests/generated/"]
      }
    )).toThrow("unapproved test path");
  });

  it("enforces case-level allowed-file containment", () => {
    expect(validateAllowedChangedPaths(
      ["storefront/service.py", "tests/generated/test_confirmation.py"],
      ["storefront/service.py", ["tests/generated/"]]
    )).toEqual([]);
    expect(validateAllowedChangedPaths(
      ["storefront/service.py", "README.md"],
      ["storefront/service.py", ["tests/generated/"]]
    )).toEqual(["Generated change exceeded allowed file containment: README.md"]);
  });

  it("builds pytest and unittest commands only for changed Python tests", () => {
    const changedPaths = ["storefront/service.py", "tests/generated/test_confirmation.py"];
    expect(buildChangedPythonTestCommand(changedPaths, {
      runner: "pytest",
      pytestCommand: "uv run --with pytest==8.4.1 python -m pytest -q"
    })).toBe('uv run --with pytest==8.4.1 python -m pytest -q "tests/generated/test_confirmation.py"');
    expect(buildChangedPythonTestCommand(changedPaths, { runner: "unittest" }))
      .toBe('python3 -m unittest "tests.generated.test_confirmation"');
    expect(buildChangedPythonTestCommand(["storefront/service.py"], { runner: "pytest" })).toBeUndefined();
  });

  it("reports model and deterministic repair attempts separately", () => {
    expect(summarizeRepairAttempts(
      [
        { phase: "planning" },
        { phase: "generation-and-repair" },
        { phase: "generation-and-repair" },
        { phase: "check-repair" }
      ],
      ["initial", "model-repair-improved-1", "deterministic-repair-improved-1"],
      ["check-repair-improved"]
    )).toEqual({
      modelAttempts: 2,
      deterministicAttempts: 1,
      totalAttempts: 3,
      stages: [
        "model-repair-improved-1",
        "deterministic-repair-improved-1",
        "check-repair-improved"
      ]
    });
  });

  it("removes immutable oracles from model-visible context", () => {
    const files = [
      { path: "src/service.py", content: "code", reason: "issue file" },
      { path: "tests/oracles/test_sla.py", content: "secret assertion", reason: "reference" }
    ];

    expect(partitionVisibleContext(files, ["tests/oracles/test_sla.py"])).toEqual({
      visible: [files[0]],
      oracles: [files[1]]
    });
  });

  it("replaces immutable planned test edits with independent generated coverage", () => {
    expect(sanitizePlanForImmutablePaths({
      requiredFiles: [
        { path: "mosaic_demo/service.py", reason: "fix behavior" },
        { path: "tests/reported/test_001_sla_sort.py", reason: "extend the reported oracle" }
      ],
      acceptanceCriteria: ["SLA ordering is correct"],
      implementationChecklist: [
        "Fix mosaic_demo/service.py",
        "Extend tests/reported/test_001_sla_sort.py with a tie-breaker"
      ],
      verificationChecklist: ["Run tests/reported/test_001_sla_sort.py"],
      verificationCommands: ["python3 -m unittest tests.reported.test_001_sla_sort"]
    }, {
      oraclePaths: [],
      oraclePathPrefixes: ["tests/reported/", "tests/smoke/"],
      generatedTestPathPrefixes: ["tests/generated/"]
    })).toEqual({
      requiredFiles: [
        { path: "mosaic_demo/service.py", reason: "fix behavior" },
        {
          path: "tests/generated/test_001_sla_sort.py",
          reason: "Add independent generated regression coverage; verification-only tests remain immutable"
        }
      ],
      acceptanceCriteria: ["SLA ordering is correct"],
      implementationChecklist: [
        "Fix mosaic_demo/service.py",
        "Extend tests/generated/test_001_sla_sort.py with a tie-breaker"
      ],
      verificationChecklist: ["Run tests/generated/test_001_sla_sort.py"],
      verificationCommands: ["python3 -m unittest tests.generated.test_001_sla_sort"]
    });
  });

  it("relocates newly planned tests into the approved generated-test namespace", () => {
    expect(sanitizePlanForImmutablePaths({
      requiredFiles: [
        { path: "storefront/service.py", reason: "fix confirmation behavior" },
        { path: "tests/test_shipping_confirmation.py", reason: "add regression coverage" }
      ],
      acceptanceCriteria: ["Shipping confirmations use the current address"],
      implementationChecklist: ["Add tests/test_shipping_confirmation.py"],
      verificationChecklist: ["Run tests/test_shipping_confirmation.py"],
      verificationCommands: ["python3 -m pytest tests/test_shipping_confirmation.py"]
    }, {
      oraclePaths: [],
      oraclePathPrefixes: ["tests/baseline/", "tests/oracle/"],
      generatedTestPathPrefixes: ["tests/generated/"]
    })).toEqual({
      requiredFiles: [
        { path: "storefront/service.py", reason: "fix confirmation behavior" },
        {
          path: "tests/generated/test_shipping_confirmation.py",
          reason: "Add independent generated regression coverage; verification-only tests remain immutable"
        }
      ],
      acceptanceCriteria: ["Shipping confirmations use the current address"],
      implementationChecklist: ["Add tests/generated/test_shipping_confirmation.py"],
      verificationChecklist: ["Run tests/generated/test_shipping_confirmation.py"],
      verificationCommands: ["python3 -m pytest tests/generated/test_shipping_confirmation.py"]
    });
  });

  it("relocates only newly invented tests out of immutable oracle prefixes", () => {
    const relocated = relocateGeneratedTestsFromImmutablePaths([
      {
        filePath: "tests/smoke/test_sla_sort_order.py",
        originalContent: "",
        modifiedContent: "def test_order(): assert True\n",
        explanation: "add generated coverage"
      },
      {
        filePath: "mosaic_demo/service.py",
        originalContent: "old\n",
        modifiedContent: "new\n",
        explanation: "fix behavior"
      }
    ], {
      oraclePaths: [],
      oraclePathPrefixes: ["tests/reported/", "tests/smoke/"],
      generatedTestPathPrefixes: ["tests/generated/"]
    });

    expect(relocated.map((change) => change.filePath)).toEqual([
      "tests/generated/test_sla_sort_order.py",
      "mosaic_demo/service.py"
    ]);
    expect(() => relocateGeneratedTestsFromImmutablePaths([{
      filePath: "tests/reported/test_existing.py",
      originalContent: "def test_existing(): pass\n",
      modifiedContent: "def test_existing(): assert True\n",
      explanation: "edit oracle"
    }], {
      oraclePaths: [],
      oraclePathPrefixes: ["tests/reported/"],
      generatedTestPathPrefixes: ["tests/generated/"]
    })).toThrow("immutable oracle");
  });

  it("persists the plan, context, changes, histories, and final diff", async () => {
    const outputDir = await tempDirs.create("mosaic-eval-artifacts-");

    await writeCaseArtifacts(outputDir, {
      plan: { requiredFiles: [{ path: "src/service.py", reason: "fix ordering" }] },
      selectedContext: [{ path: "src/service.py", reason: "reported file" }],
      changes: [{
        filePath: "src/service.py",
        originalContent: "old\n",
        modifiedContent: "new\n",
        explanation: "fix"
      }],
      validationHistory: [{ stage: "generation", errors: [] }],
      validationCandidates: [{
        stage: "generation",
        selected: false,
        changes: [{
          filePath: "src/service.py",
          originalContent: "old\n",
          modifiedContent: "rejected\n",
          explanation: "rejected candidate"
        }]
      }],
      verificationHistory: [{ stage: "initial", errors: [] }]
    });

    await expect(readFile(join(outputDir, "plan.json"), "utf8")).resolves.toContain("src/service.py");
    await expect(readFile(join(outputDir, "selected-context.json"), "utf8")).resolves.toContain("reported file");
    await expect(readFile(join(outputDir, "change-manifest.json"), "utf8")).resolves.toContain("fix");
    await expect(readFile(join(outputDir, "validation-history.json"), "utf8")).resolves.toContain("generation");
    await expect(readFile(join(outputDir, "validation-candidates.json"), "utf8")).resolves.toContain("rejected candidate");
    await expect(readFile(join(outputDir, "verification-history.json"), "utf8")).resolves.toContain("initial");
    await expect(readFile(join(outputDir, "final.diff"), "utf8")).resolves.toContain("-old\n+new");
  });

  it("prevents another call when its maximum estimated cost exceeds the remaining budget", () => {
    const budget = new EvalBudget(0.02);
    budget.record({
      model: "test-model",
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0.015
    });

    expect(() => budget.authorize({ estimatedMaxCostUsd: 0.006 })).toThrow("budget");
    expect(() => budget.authorize({ estimatedMaxCostUsd: 0.005 })).not.toThrow();
  });

  it("calculates executor and cache token cost from exact usage", () => {
    expect(calculateUsageCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadInputTokens: 500_000,
      cacheCreationInputTokens: 200_000
    }, {
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
      cacheReadUsdPerMillion: 0.3,
      cacheCreationUsdPerMillion: 3.75
    })).toBeCloseTo(5.4, 10);
  });

  it("does not double-count OpenAI cached tokens included in total input usage", () => {
    expect(calculateUsageCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadInputTokens: 200_000,
      cacheCreationInputTokens: 0
    }, {
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 30,
      cacheReadUsdPerMillion: 0.5,
      cacheCreationUsdPerMillion: 5,
      inputTokensIncludeCacheReads: true
    })).toBeCloseTo(4.1, 10);
  });

  it("calculates executor and advisor iterations at their exact model rates", () => {
    expect(calculateUsageIterationsCostUsd([
      {
        type: "message",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0
      },
      {
        type: "advisor_message",
        model: "claude-opus-4-8",
        inputTokens: 500_000,
        outputTokens: 20_000,
        cacheReadInputTokens: 100_000,
        cacheCreationInputTokens: 0
      }
    ], {
      "claude-sonnet-4-6": {
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
        cacheReadUsdPerMillion: 0.3,
        cacheCreationUsdPerMillion: 3.75
      },
      "claude-opus-4-8": {
        inputUsdPerMillion: 5,
        outputUsdPerMillion: 25,
        cacheReadUsdPerMillion: 0.5,
        cacheCreationUsdPerMillion: 6.25
      }
    })).toBeCloseTo(7.55, 10);
  });

  it("reserves executor output as possible advisor input context", () => {
    expect(estimateMaximumAdvisorCallCostUsd(
      10_000,
      8_000,
      2_000,
      {
        inputUsdPerMillion: 5,
        outputUsdPerMillion: 25,
        cacheReadUsdPerMillion: 0.5,
        cacheCreationUsdPerMillion: 6.25
      }
    )).toBeCloseTo(0.14, 10);
  });

  it("rejects unrelated Python behavior changes inside an allowed file", () => {
    const originalContent = [
      "def create_request():",
      "    return 'created'",
      "",
      "def list_requests():",
      "    return 'created_at'",
      "",
      "def close_request():",
      "    return 'updated'",
      ""
    ].join("\n");
    const modifiedContent = originalContent
      .replace("return 'created'", "return 'idempotent'")
      .replace("return 'created_at'", "return 'sla_due_at'");

    expect(validateUnchangedPythonSymbols({
      filePath: "service.py",
      originalContent,
      modifiedContent
    }, ["list_requests", "close_request"])).toEqual([
      "Unrelated protected symbol changed in service.py: list_requests"
    ]);
  });

  it("rejects unrelated JavaScript and TypeScript symbol changes inside allowed files", () => {
    const originalContent = [
      "export const convertToFilePath = (url: string): string => {",
      "  return url.replace('file://', '');",
      "};",
      "",
      "export const testStory = (story: Story) => {",
      "  return runStory(story);",
      "};",
      ""
    ].join("\n");
    const modifiedContent = originalContent
      .replace("url.replace('file://', '')", "url.replace('https://', '')")
      .replace("runStory(story)", "runStoryWithFallback(story)");

    expect(validateUnchangedSymbols({
      filePath: "test-utils.ts",
      originalContent,
      modifiedContent
    }, ["convertToFilePath"])).toEqual([
      "Unrelated protected symbol changed in test-utils.ts: convertToFilePath"
    ]);

    expect(validateUnchangedSymbols({
      filePath: "test-utils.ts",
      originalContent,
      modifiedContent: originalContent.replace("runStory(story)", "runStoryWithFallback(story)")
    }, ["convertToFilePath"])).toEqual([]);
  });

  it("allows one required field addition while preserving the rest of a protected Python symbol", () => {
    const originalContent = [
      "def list_requests(conn, sort='created'):",
      "    order_by = 'sr.created_at DESC'",
      "    return conn.execute('SELECT sr.id, sr.title FROM service_requests ORDER BY ' + order_by)",
      ""
    ].join("\n");
    const withBody = originalContent.replace("sr.id, sr.title", "sr.id, sr.title, sr.body");
    expect(validateUnchangedSymbolsWithAllowedLines({
      filePath: "mosaic_demo/service.py",
      originalContent,
      modifiedContent: withBody
    }, { list_requests: ["sr.body"] })).toEqual([]);

    expect(validateUnchangedSymbolsWithAllowedLines({
      filePath: "mosaic_demo/service.py",
      originalContent,
      modifiedContent: withBody.replace("sr.created_at DESC", "sr.sla_due_at ASC")
    }, { list_requests: ["sr.body"] })).toEqual([
      "Unrelated protected symbol changed in mosaic_demo/service.py: list_requests"
    ]);
  });

  it("serializes frontend selector failures as a typed repair requirement", () => {
    const error = formatFrontendRepairRequirement({
      assertion: "Kitchen collection opens a populated modal",
      action: "assert",
      selectorAlternatives: ["#collectionModalOverlay", "#modal-kitchen"],
      expectation: {
        kind: "class_any",
        values: ["is-open", "active"]
      },
      actual: {
        matchCount: 1,
        classes: ["col-modal-overlay"]
      }
    });

    expect(error).toBe(
      "Frontend repair requirement: " + JSON.stringify({
        assertion: "Kitchen collection opens a populated modal",
        action: "assert",
        selectorAlternatives: ["#collectionModalOverlay", "#modal-kitchen"],
        expectation: {
          kind: "class_any",
          values: ["is-open", "active"]
        },
        actual: {
          matchCount: 1,
          classes: ["col-modal-overlay"]
        }
      })
    );
  });

  it("recognizes native and ARIA dialog open state semantically", () => {
    const dom = new JSDOM(
      '<dialog id="native" open></dialog><div id="aria" role="dialog" aria-hidden="false"></div>'
    );
    const nativeDialog = dom.window.document.querySelector("#native") as Element;
    const ariaDialog = dom.window.document.querySelector("#aria") as Element;

    expect(frontendElementHasDialogSemantics(nativeDialog)).toBe(true);
    expect(frontendElementIsOpen(nativeDialog)).toBe(true);
    expect(frontendElementHasDialogSemantics(ariaDialog)).toBe(true);
    expect(frontendElementIsOpen(ariaDialog)).toBe(true);

    nativeDialog.removeAttribute("open");
    ariaDialog.setAttribute("aria-hidden", "true");
    expect(frontendElementIsOpen(nativeDialog)).toBe(false);
    expect(frontendElementIsOpen(ariaDialog)).toBe(false);
    dom.window.close();
  });
});

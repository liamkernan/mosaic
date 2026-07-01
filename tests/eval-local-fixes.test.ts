import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EvalBudget,
  DEFAULT_EVAL_CASE_TIMEOUT_MS,
  assertGeneratedPathsAllowed,
  calculateUsageCostUsd,
  calculateUsageIterationsCostUsd,
  createEvalTrialRuns,
  estimateMaximumAdvisorCallCostUsd,
  formatFrontendRepairRequirement,
  partitionVisibleContext,
  relocateGeneratedTestsFromImmutablePaths,
  sanitizePlanForImmutablePaths,
  runEvalCaseBatch,
  summarizeEvalTrials,
  validateUnchangedSymbols,
  validateUnchangedSymbolsWithAllowedLines,
  validateUnchangedPythonSymbols,
  writeCaseArtifacts,
  writeEvalReport
} from "../scripts/eval-local-fixes-support.js";

describe("local fix evaluation harness", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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

  it("writes a machine-readable result for every selected case", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "mosaic-eval-report-"));
    tempDirs.push(outputDir);
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
          reason: "Add independent generated regression coverage; the reported oracle remains verification-only"
        }
      ],
      acceptanceCriteria: ["SLA ordering is correct"],
      implementationChecklist: [
        "Fix mosaic_demo/service.py",
        "Extend tests/generated/test_001_sla_sort.py with a tie-breaker"
      ],
      verificationChecklist: ["Run tests/reported/test_001_sla_sort.py"],
      verificationCommands: ["python3 -m unittest tests.reported.test_001_sla_sort"]
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
    const outputDir = await mkdtemp(join(tmpdir(), "mosaic-eval-artifacts-"));
    tempDirs.push(outputDir);

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
});

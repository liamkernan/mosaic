import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  EvalBudget,
  assertGeneratedPathsAllowed,
  calculateUsageCostUsd,
  partitionVisibleContext,
  runEvalCaseBatch,
  validateUnchangedPythonSymbols,
  writeCaseArtifacts,
  writeEvalReport
} from "../scripts/eval-local-fixes-support.js";

describe("local fix evaluation harness", () => {
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

  it("persists the plan, context, changes, histories, and final diff", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "mosaic-eval-artifacts-"));

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
      verificationHistory: [{ stage: "initial", errors: [] }]
    });

    await expect(readFile(join(outputDir, "plan.json"), "utf8")).resolves.toContain("src/service.py");
    await expect(readFile(join(outputDir, "selected-context.json"), "utf8")).resolves.toContain("reported file");
    await expect(readFile(join(outputDir, "change-manifest.json"), "utf8")).resolves.toContain("fix");
    await expect(readFile(join(outputDir, "validation-history.json"), "utf8")).resolves.toContain("generation");
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
});

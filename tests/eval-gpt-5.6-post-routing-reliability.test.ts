import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { assessFeedbackContent } from "../packages/intake/src/abuse-protection.js";

const execFile = promisify(execFileCallback);
const casesPath = "evals/gpt-5.6-post-routing-reliability-cases-2026-07-14.json";
const fixturePath = "evals/fixtures/post-routing-reliability";
const fixtureRoot = resolve(fixturePath);

interface ReliabilityCase {
  id: string;
  fixturePath: string;
  feedback: {
    rawContent: string;
    relevantFiles: string[];
  };
  expectedSafetyOutcome: "accepted" | "rejected";
  expectedOpenAIRoute?: {
    model: string;
    reasoningEffort: string;
  };
  oracleTestPathPrefixes?: string[];
  generatedTestPathPrefixes?: string[];
  requiredChangedFilePatterns?: Array<string | string[]>;
  allowedChangedFilePatterns?: Array<string | string[]>;
  runChangedPythonTests?: boolean;
}

async function loadCases(): Promise<ReliabilityCase[]> {
  return JSON.parse(await readFile(casesPath, "utf8")) as ReliabilityCase[];
}

async function unittestExitCode(module: string): Promise<number> {
  try {
    await execFile("python3", ["-m", "unittest", module], {
      cwd: fixtureRoot,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
    });
    return 0;
  } catch (error) {
    return (error as { code?: number }).code ?? -1;
  }
}

describe("frozen GPT-5.6 post-routing reliability evaluation", () => {
  it("contains exactly one fresh safe case per automatic route plus deterministic rejection", async () => {
    const cases = await loadCases();
    const routes = cases.map((item) => item.expectedOpenAIRoute
      ? `${item.expectedOpenAIRoute.model}/${item.expectedOpenAIRoute.reasoningEffort}`
      : "rejected-before-model");

    expect(cases).toHaveLength(6);
    expect(new Set(cases.map(({ id }) => id)).size).toBe(6);
    expect(routes.sort()).toEqual([
      "gpt-5.6-luna/high",
      "gpt-5.6-sol/high",
      "gpt-5.6-sol/xhigh",
      "gpt-5.6-terra/high",
      "gpt-5.6-terra/xhigh",
      "rejected-before-model"
    ]);
    expect(cases.every((item) => item.fixturePath === fixturePath)).toBe(true);
    for (const item of cases) {
      expect(Object.hasOwn(item, "model"), item.id).toBe(false);
      expect(Object.hasOwn(item, "reasoningEffort"), item.id).toBe(false);
    }
  });

  it("accepts safe feedback and rejects the unsafe request before model use", async () => {
    for (const item of await loadCases()) {
      const assessment = assessFeedbackContent(item.feedback.rawContent);
      expect(assessment.accepted, item.id)
        .toBe(item.expectedSafetyOutcome === "accepted");
      if (item.expectedSafetyOutcome === "rejected") {
        expect(item.expectedOpenAIRoute, item.id).toBeUndefined();
        expect(item.allowedChangedFilePatterns, item.id).toEqual([]);
      }
    }
  });

  it("keeps fixture-native oracles hidden and candidate regressions contained", async () => {
    const cases = (await loadCases()).filter(({ expectedSafetyOutcome }) => expectedSafetyOutcome === "accepted");
    for (const item of cases) {
      expect(item.oracleTestPathPrefixes, item.id).toEqual(["tests/oracle/"]);
      expect(item.generatedTestPathPrefixes, item.id).toEqual(["tests/generated/"]);
      expect(item.feedback.relevantFiles.some((path) => path.startsWith("tests/oracle/")), item.id).toBe(false);

      const allowed = new Set((item.allowedChangedFilePatterns ?? []).map((pattern) => JSON.stringify(pattern)));
      for (const required of item.requiredChangedFilePatterns ?? []) {
        expect(allowed.has(JSON.stringify(required)), item.id).toBe(true);
      }
      expect(allowed.has(JSON.stringify(["tests/generated/"])), item.id).toBe(true);
    }

    const generatedTestCases = cases.filter(({ id }) => [
      "post-routing-moderate-safe-details-state",
      "post-routing-moderate-review-incident-revision",
      "post-routing-complex-escalation-export"
    ].includes(id));
    expect(generatedTestCases).toHaveLength(3);
    for (const item of generatedTestCases) {
      expect(item.runChangedPythonTests, item.id).toBe(true);
      expect(item.requiredChangedFilePatterns, item.id).toContainEqual(["tests/generated/"]);
    }
  });

  it("starts from a passing baseline and five independently sensitive hidden oracles", async () => {
    expect(await unittestExitCode("tests.baseline.test_fixture_baseline")).toBe(0);
    for (const oracle of [
      "tests.oracle.test_heading_typo",
      "tests.oracle.test_watch_label",
      "tests.oracle.test_details_state",
      "tests.oracle.test_incident_revision",
      "tests.oracle.test_escalation_export"
    ]) {
      expect(await unittestExitCode(oracle), oracle).not.toBe(0);
    }
  });
});

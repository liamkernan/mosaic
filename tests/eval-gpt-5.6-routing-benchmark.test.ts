import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { assessFeedbackContent } from "../packages/intake/src/abuse-protection.js";

type Split = "development" | "holdout";
type ExpectedRouteKey =
  | "rejected-before-model"
  | "trivial"
  | "simple"
  | "moderate-safe"
  | "moderate-review-needed"
  | "complex-review-needed";

interface RoutingInputCase {
  id: string;
  split: Split;
  domain: string;
  boundaryPairId: string;
  repoFullName: string;
  source: "web_form";
  senderIdentifier: string;
  rawContent: string;
  fileTree: string[];
}

interface RoutingExpectation {
  id: string;
  expectedSafetyOutcome: "accepted" | "rejected";
  expectedCategory?: string;
  expectedComplexity?: string;
  expectedReview: "none" | "not-required" | "required";
  expectedRoute: {
    key: ExpectedRouteKey;
    model: string | null;
    reasoningEffort: string | null;
  };
  rationale: string;
  boundary: {
    contrastCaseId: string;
    factor: string;
  };
}

interface RoutingInputsFile {
  schemaVersion: number;
  benchmarkId: string;
  frozenAt: string;
  cases: RoutingInputCase[];
}

interface RoutingExpectationsFile {
  schemaVersion: number;
  benchmarkId: string;
  frozenAt: string;
  expectations: RoutingExpectation[];
}

const inputsPath = "evals/gpt-5.6-routing-benchmark-2026-07-14.inputs.json";
const expectationsPath = "evals/gpt-5.6-routing-benchmark-2026-07-14.expected.json";

async function loadBenchmark(): Promise<{
  inputs: RoutingInputsFile;
  expected: RoutingExpectationsFile;
}> {
  const [inputs, expected] = await Promise.all([
    readFile(inputsPath, "utf8"),
    readFile(expectationsPath, "utf8")
  ]);
  return {
    inputs: JSON.parse(inputs) as RoutingInputsFile,
    expected: JSON.parse(expected) as RoutingExpectationsFile
  };
}

const expectedSelections = new Map<ExpectedRouteKey, { model: string | null; reasoningEffort: string | null }>([
  ["rejected-before-model", { model: null, reasoningEffort: null }],
  ["trivial", { model: "gpt-5.6-luna", reasoningEffort: "high" }],
  ["simple", { model: "gpt-5.6-terra", reasoningEffort: "high" }],
  ["moderate-safe", { model: "gpt-5.6-terra", reasoningEffort: "xhigh" }],
  ["moderate-review-needed", { model: "gpt-5.6-sol", reasoningEffort: "high" }],
  ["complex-review-needed", { model: "gpt-5.6-sol", reasoningEffort: "xhigh" }]
]);

describe("frozen GPT-5.6 production-routing benchmark", () => {
  it("balances 24 cases across six outcomes and the development/holdout split", async () => {
    const { inputs, expected } = await loadBenchmark();
    expect(inputs.schemaVersion).toBe(1);
    expect(expected.schemaVersion).toBe(1);
    expect(inputs.benchmarkId).toBe("gpt-5.6-production-routing-2026-07-14");
    expect(expected.benchmarkId).toBe(inputs.benchmarkId);
    expect(expected.frozenAt).toBe(inputs.frozenAt);
    expect(inputs.cases).toHaveLength(24);
    expect(expected.expectations).toHaveLength(24);

    const expectationsById = new Map(expected.expectations.map((item) => [item.id, item]));
    expect(new Set(inputs.cases.map((item) => item.id)).size).toBe(24);
    expect(new Set(expected.expectations.map((item) => item.id)).size).toBe(24);
    expect([...expectationsById.keys()].sort()).toEqual(inputs.cases.map((item) => item.id).sort());

    for (const [routeKey] of expectedSelections) {
      const matching = inputs.cases.filter((item) => expectationsById.get(item.id)?.expectedRoute.key === routeKey);
      expect(matching, routeKey).toHaveLength(4);
      expect(matching.filter((item) => item.split === "development"), routeKey + " development").toHaveLength(3);
      expect(matching.filter((item) => item.split === "holdout"), routeKey + " holdout").toHaveLength(1);
    }
  });

  it("keeps expected answers and rationales out of production classifier inputs", async () => {
    const { inputs } = await loadBenchmark();
    const allowedInputKeys = [
      "boundaryPairId",
      "domain",
      "fileTree",
      "id",
      "rawContent",
      "repoFullName",
      "senderIdentifier",
      "source",
      "split"
    ].sort();

    for (const inputCase of inputs.cases) {
      expect(Object.keys(inputCase).sort(), inputCase.id).toEqual(allowedInputKeys);
      expect(inputCase.rawContent.length, inputCase.id).toBeGreaterThan(40);
      expect(inputCase.fileTree.length, inputCase.id).toBeGreaterThanOrEqual(6);
    }
  });

  it("freezes exact model selections and non-empty rationales", async () => {
    const { expected } = await loadBenchmark();

    for (const expectation of expected.expectations) {
      expect(expectation.expectedRoute, expectation.id).toMatchObject(
        expectedSelections.get(expectation.expectedRoute.key) ?? {}
      );
      expect(expectation.rationale.trim().length, expectation.id).toBeGreaterThan(40);
      expect(expectation.boundary.factor.trim().length, expectation.id).toBeGreaterThan(30);

      if (expectation.expectedSafetyOutcome === "accepted") {
        expect(expectation.expectedCategory, expectation.id).toBeTruthy();
        expect(expectation.expectedComplexity, expectation.id).toBeTruthy();
        expect(expectation.expectedRoute.key, expectation.id).not.toBe("rejected-before-model");
      } else {
        expect(expectation.expectedCategory, expectation.id).toBeUndefined();
        expect(expectation.expectedComplexity, expectation.id).toBeUndefined();
        expect(expectation.expectedRoute.key, expectation.id).toBe("rejected-before-model");
      }
    }
  });

  it("uses reciprocal two-case boundary pairs that stay within one split", async () => {
    const { inputs, expected } = await loadBenchmark();
    const expectationsById = new Map(expected.expectations.map((item) => [item.id, item]));
    const inputsById = new Map(inputs.cases.map((item) => [item.id, item]));
    const pairs = new Map<string, RoutingInputCase[]>();

    for (const inputCase of inputs.cases) {
      const current = pairs.get(inputCase.boundaryPairId) ?? [];
      current.push(inputCase);
      pairs.set(inputCase.boundaryPairId, current);
    }

    expect(pairs.size).toBe(12);
    for (const [pairId, pair] of pairs) {
      expect(pair, pairId).toHaveLength(2);
      expect(new Set(pair.map((item) => item.split)).size, pairId).toBe(1);
      expect(pair[0]?.fileTree, pairId).toEqual(pair[1]?.fileTree);

      for (const inputCase of pair) {
        const contrastId = expectationsById.get(inputCase.id)?.boundary.contrastCaseId;
        expect(contrastId, inputCase.id).toBe(pair.find((item) => item.id !== inputCase.id)?.id);
        expect(inputsById.get(contrastId ?? "")?.boundaryPairId, inputCase.id).toBe(pairId);
      }
    }
  });

  it("covers the requested domains and deterministically separates safe from unsafe input", async () => {
    const { inputs, expected } = await loadBenchmark();
    const expectationsById = new Map(expected.expectations.map((item) => [item.id, item]));
    const domains = inputs.cases.map((item) => item.domain).join(" ");

    for (const requiredDomain of ["frontend", "backend", "accessibility", "data-integrity", "full-stack", "security", "containment"]) {
      expect(domains, requiredDomain).toContain(requiredDomain);
    }

    for (const inputCase of inputs.cases) {
      const assessment = assessFeedbackContent(inputCase.rawContent);
      const expectedOutcome = expectationsById.get(inputCase.id)?.expectedSafetyOutcome;
      expect(assessment.accepted, inputCase.id).toBe(expectedOutcome === "accepted");
    }
  });
});

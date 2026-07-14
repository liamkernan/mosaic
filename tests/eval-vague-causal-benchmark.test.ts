import { readFile } from "node:fs/promises";

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import type { ClassifiedFeedback } from "../packages/core/src/types.js";
import { assessFeedbackContent } from "../packages/intake/src/abuse-protection.js";
import { resolveEvalLlmRoutes } from "../scripts/eval-llm-routing.js";

interface BenchmarkCase {
  id: string;
  routingTier: string;
  fixturePath: string;
  feedback: Omit<ClassifiedFeedback, "id" | "repoFullName" | "receivedAt" | "metadata">;
  expectedSafetyOutcome: "accepted" | "rejected";
  oracleTestPathPrefixes?: string[];
  generatedTestPathPrefixes?: string[];
  verificationCommands?: string[];
  requiredChangedFilePatterns?: Array<string | string[]>;
  allowedChangedFilePatterns?: Array<string | string[]>;
}

const casesPath = "evals/gpt-5.6-vague-causal-cases-2026-07-14.json";
const fixturePath = "evals/fixtures/vague-commerce";

async function loadCases(): Promise<BenchmarkCase[]> {
  return JSON.parse(await readFile(casesPath, "utf8")) as BenchmarkCase[];
}

describe("fresh vague and causal benchmark", () => {
  it("covers all five pinned GPT-5.6 quality routes plus deterministic rejection", async () => {
    const cases = await loadCases();
    const expectedRoutes = new Map([
      ["trivial", { model: "gpt-5.6-luna", reasoningEffort: "high" }],
      ["simple", { model: "gpt-5.6-terra", reasoningEffort: "high" }],
      ["moderate-safe", { model: "gpt-5.6-terra", reasoningEffort: "xhigh" }],
      ["moderate-review-needed", { model: "gpt-5.6-sol", reasoningEffort: "high" }],
      ["complex-review-needed", { model: "gpt-5.6-sol", reasoningEffort: "xhigh" }]
    ]);

    expect(cases.map((benchmarkCase) => benchmarkCase.routingTier).sort()).toEqual([
      "complex-review-needed",
      "moderate-review-needed",
      "moderate-safe",
      "rejected-before-routing",
      "simple",
      "trivial"
    ]);

    for (const benchmarkCase of cases.filter(({ expectedSafetyOutcome }) => expectedSafetyOutcome === "accepted")) {
      const feedback: ClassifiedFeedback = {
        id: benchmarkCase.id,
        repoFullName: "mosaic-eval/vague-commerce",
        receivedAt: new Date("2026-07-14T00:00:00Z"),
        metadata: {},
        ...benchmarkCase.feedback
      };
      const routes = resolveEvalLlmRoutes({
        provider: "openai",
        model: "terra",
        preset: "quality",
        feedback
      });
      expect(routes.planning, benchmarkCase.id).toEqual(expectedRoutes.get(benchmarkCase.routingTier));
      expect(routes.generation, benchmarkCase.id).toEqual(expectedRoutes.get(benchmarkCase.routingTier));
    }
  });

  it("accepts every valid outcome and rejects the unsafe case before routing", async () => {
    for (const benchmarkCase of await loadCases()) {
      const assessment = assessFeedbackContent(benchmarkCase.feedback.rawContent);
      expect(assessment.accepted, benchmarkCase.id)
        .toBe(benchmarkCase.expectedSafetyOutcome === "accepted");
    }
  });

  it("keeps Python oracles hidden and uses pinned pytest verification", async () => {
    const cases = await loadCases();
    const backendCase = cases.find(({ id }) => id === "vague-moderate-review-current-shipping-address");
    expect(backendCase?.oracleTestPathPrefixes).toEqual(["tests/baseline/", "tests/oracle/"]);
    expect(backendCase?.generatedTestPathPrefixes).toEqual(["tests/generated/"]);
    expect(backendCase?.feedback.relevantFiles).not.toContain("tests/oracle/test_current_shipping_address.py");
    expect(backendCase?.verificationCommands).toEqual([
      "uv run --with pytest==8.4.1 python -m pytest -q tests/baseline tests/oracle/test_current_shipping_address.py"
    ]);
    await expect(readFile(`${fixturePath}/tests/oracle/test_current_shipping_address.py`, "utf8"))
      .resolves.toContain("current_nonblank_address");

    for (const benchmarkCase of cases.filter(({ expectedSafetyOutcome }) => expectedSafetyOutcome === "accepted")) {
      expect(benchmarkCase.oracleTestPathPrefixes, benchmarkCase.id)
        .toEqual(["tests/baseline/", "tests/oracle/"]);
      expect(benchmarkCase.feedback.relevantFiles, benchmarkCase.id)
        .not.toContain("tests/oracle/test_current_shipping_address.py");
    }
  });

  it("declares exact allowed-file containment for every generated case", async () => {
    for (const benchmarkCase of (await loadCases()).filter(({ expectedSafetyOutcome }) => expectedSafetyOutcome === "accepted")) {
      expect(benchmarkCase.allowedChangedFilePatterns, benchmarkCase.id)
        .toEqual(benchmarkCase.requiredChangedFilePatterns);
    }
  });

  it("starts with real frontend failures instead of inert or already-satisfied requests", async () => {
    const html = await readFile(`${fixturePath}/index.html`, "utf8");
    const script = await readFile(`${fixturePath}/script.js`, "utf8");
    const dom = new JSDOM(html, { runScripts: "outside-only" });
    dom.window.eval(script);

    expect(dom.window.document.querySelector("#featuredTitle")?.textContent).toContain("arrvials");
    expect(dom.window.document.querySelector("#cartButton")?.hasAttribute("aria-label")).toBe(false);
    expect(dom.window.document.querySelector("#cartTitle")?.textContent).toBe("Your bag is empty");
    expect(dom.window.document.querySelector("#quickViewClose")?.tagName).toBe("SPAN");

    const linenButton = dom.window.document.querySelector<HTMLButtonElement>(
      '.quick-view[data-product-key="linen-throw"]'
    );
    linenButton?.click();
    expect(dom.window.document.querySelector("#quickViewTitle")?.textContent).toBe("Clay Lamp");
    expect(dom.window.document.querySelector("#quickViewPanel")?.getAttribute("aria-hidden")).toBe("true");
    dom.window.close();
  });
});

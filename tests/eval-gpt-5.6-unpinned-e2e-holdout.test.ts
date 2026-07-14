import { readFile } from "node:fs/promises";

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import { assessFeedbackContent } from "../packages/intake/src/abuse-protection.js";

interface E2EHoldoutCase {
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
}

const casesPath = "evals/gpt-5.6-unpinned-e2e-holdout-2026-07-14.json";
const fixturePath = "evals/fixtures/routing-holdout";

async function loadCases(): Promise<E2EHoldoutCase[]> {
  return JSON.parse(await readFile(casesPath, "utf8")) as E2EHoldoutCase[];
}

describe("fresh unpinned GPT-5.6 end-to-end holdout", () => {
  it("contains one previously unused case for each safe route plus unsafe rejection", async () => {
    const cases = await loadCases();
    const routes = cases.map((item) => item.expectedOpenAIRoute
      ? item.expectedOpenAIRoute.model + "/" + item.expectedOpenAIRoute.reasoningEffort
      : "rejected-before-model");

    expect(cases).toHaveLength(6);
    expect(new Set(cases.map((item) => item.id)).size).toBe(6);
    expect(routes.sort()).toEqual([
      "gpt-5.6-luna/high",
      "gpt-5.6-sol/high",
      "gpt-5.6-sol/xhigh",
      "gpt-5.6-terra/high",
      "gpt-5.6-terra/xhigh",
      "rejected-before-model"
    ]);
    expect(cases.every((item) => item.fixturePath === fixturePath)).toBe(true);
  });

  it("accepts every safe case and rejects unsafe feedback before model use", async () => {
    for (const holdoutCase of await loadCases()) {
      const assessment = assessFeedbackContent(holdoutCase.feedback.rawContent);
      expect(assessment.accepted, holdoutCase.id)
        .toBe(holdoutCase.expectedSafetyOutcome === "accepted");
      if (holdoutCase.expectedSafetyOutcome === "rejected") {
        expect(holdoutCase.expectedOpenAIRoute, holdoutCase.id).toBeUndefined();
        expect(holdoutCase.allowedChangedFilePatterns, holdoutCase.id).toEqual([]);
      }
    }
  });

  it("keeps hidden oracles out of model context and generated tests contained", async () => {
    for (const holdoutCase of (await loadCases()).filter((item) => item.expectedSafetyOutcome === "accepted")) {
      expect(holdoutCase.oracleTestPathPrefixes, holdoutCase.id).toEqual(["tests/oracle/"]);
      expect(holdoutCase.generatedTestPathPrefixes, holdoutCase.id).toEqual(["tests/generated/"]);
      expect(holdoutCase.feedback.relevantFiles.some((path) => path.startsWith("tests/oracle/")), holdoutCase.id)
        .toBe(false);

      const allowed = new Set((holdoutCase.allowedChangedFilePatterns ?? []).map((pattern) => JSON.stringify(pattern)));
      for (const required of holdoutCase.requiredChangedFilePatterns ?? []) {
        expect(allowed.has(JSON.stringify(required)), holdoutCase.id).toBe(true);
      }
      expect(allowed.has(JSON.stringify(["tests/generated/"])), holdoutCase.id).toBe(true);
    }
  });

  it("starts with real independent frontend failures and preserved behavior", async () => {
    const html = await readFile(fixturePath + "/index.html", "utf8");
    const script = await readFile(fixturePath + "/script.js", "utf8");
    const dom = new JSDOM(html, { runScripts: "outside-only" });
    dom.window.eval(script);

    expect(dom.window.document.querySelector("#welcomeTitle")?.textContent).toBe("Welcomme back");
    expect(dom.window.document.querySelector("#saveFilterButton")?.hasAttribute("aria-label")).toBe(false);
    (dom.window.document.querySelector("#saveFilterButton") as HTMLButtonElement).click();
    expect(dom.window.document.querySelector("#saveFilterButton")?.getAttribute("aria-pressed")).toBe("true");
    expect(dom.window.document.querySelector("#filterStatus")?.textContent).toBe("Filter saved");

    (dom.window.document.querySelector("#sortToggle") as HTMLButtonElement).click();
    expect((dom.window.document.querySelector("#sortPanel") as HTMLElement).hidden).toBe(false);
    expect(dom.window.document.querySelector("#sortToggle")?.getAttribute("aria-expanded")).toBe("false");
    dom.window.close();
  });

  it("starts with causal backend and export-safety defects", async () => {
    const [service, repository, worker] = await Promise.all([
      readFile(fixturePath + "/portal/service.py", "utf8"),
      readFile(fixturePath + "/portal/repository.py", "utf8"),
      readFile(fixturePath + "/portal/worker.py", "utf8")
    ]);

    expect(service).toContain('order["delivery_address"] = update["delivery_address"]');
    expect(service).not.toContain('update["sequence"] > order["delivery_update_sequence"]');
    expect(repository).not.toContain("member_id ==");
    expect(worker).toContain('"sessions": sessions');
    expect(worker).toContain('"profile": profile');
  });
});

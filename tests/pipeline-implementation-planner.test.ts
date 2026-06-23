import { describe, expect, it } from "vitest";

import type { LLMClient } from "../packages/llm/src/client.js";
import { ImplementationPlanner } from "../packages/pipeline/src/implementation-planner.js";

describe("ImplementationPlanner", () => {
  it("keeps required files that are in the repo tree or already loaded", async () => {
    const fakeClient = {
      setUsageContext: () => {},
      complete: async () => JSON.stringify({
        requiredFiles: [
          { path: "./src/service.ts", reason: "existing source" },
          { path: "loaded/generated.ts", reason: "already loaded" },
          { path: "missing/ignored.ts", reason: "not in repo" }
        ],
        acceptanceCriteria: ["preserve behavior"],
        implementationChecklist: ["update implementation"],
        verificationChecklist: ["run tests"],
        verificationCommands: ["pnpm test"]
      })
    } as unknown as LLMClient;

    const plan = await new ImplementationPlanner(fakeClient).plan(
      {
        id: "01TEST",
        source: "web_form",
        rawContent: "Fix the service behavior",
        senderIdentifier: "user@example.com",
        repoFullName: "owner/repo",
        receivedAt: new Date(),
        metadata: {},
        category: "bug_report",
        complexity: "complex",
        summary: "Fix service behavior",
        relevantFiles: ["src/service.ts"],
        confidence: 0.8
      },
      [{ path: "loaded/generated.ts", content: "export const loaded = true;\n", reason: "loaded context" }],
      ["src/service.ts"]
    );

    expect(plan.requiredFiles).toEqual([
      { path: "src/service.ts", reason: "existing source" },
      { path: "loaded/generated.ts", reason: "already loaded" }
    ]);
  });
});

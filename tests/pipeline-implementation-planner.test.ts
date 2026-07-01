import { describe, expect, it, vi } from "vitest";

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

  it("repairs an endpoint plan that omits required test work before generation", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        requiredFiles: [
          { path: "mosaic_demo/service.py", reason: "add metrics aggregation" },
          { path: "mosaic_demo/web.py", reason: "add GET /metrics route" }
        ],
        acceptanceCriteria: ["GET /metrics returns open request metrics"],
        implementationChecklist: ["add service aggregation", "add route handler"],
        verificationChecklist: ["call GET /metrics"],
        verificationCommands: ["python3 -m unittest"]
      }))
      .mockResolvedValueOnce(JSON.stringify({
        requiredFiles: [
          { path: "mosaic_demo/service.py", reason: "add metrics aggregation" },
          { path: "mosaic_demo/web.py", reason: "add GET /metrics route" },
          { path: "tests/generated/test_metrics.py", reason: "cover service and HTTP handler behavior" }
        ],
        acceptanceCriteria: ["GET /metrics returns open request metrics and handles an empty queue"],
        implementationChecklist: ["add service aggregation", "add route handler"],
        verificationChecklist: ["unit test service aggregation", "handler test GET /metrics and empty state"],
        verificationCommands: ["python3 -m unittest tests.generated.test_metrics"]
      }));
    const fakeClient = {
      setUsageContext: () => {},
      complete
    } as unknown as LLMClient;

    const plan = await new ImplementationPlanner(fakeClient).plan(
      {
        id: "01METRICS",
        source: "web_form",
        rawContent: "Add GET /metrics with open counts and a stable empty state.",
        senderIdentifier: "user@example.com",
        repoFullName: "owner/repo",
        receivedAt: new Date(),
        metadata: {},
        category: "feature_request",
        complexity: "moderate",
        summary: "Add support queue metrics endpoint",
        relevantFiles: ["mosaic_demo/service.py", "mosaic_demo/web.py"],
        confidence: 0.8
      },
      [],
      ["mosaic_demo/service.py", "mosaic_demo/web.py", "tests"]
    );

    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[0]).toContain("PLAN PREFLIGHT ERRORS");
    expect(plan.requiredFiles).toContainEqual({
      path: "tests/generated/test_metrics.py",
      reason: "cover service and HTTP handler behavior"
    });
  });

  it("accepts public-path HTTP assertions as handler verification", async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({
      requiredFiles: [
        { path: "mosaic_demo/service.py", reason: "add metrics aggregation" },
        { path: "mosaic_demo/web.py", reason: "add GET /metrics route" },
        { path: "tests/generated/test_metrics.py", reason: "cover service and public HTTP behavior" }
      ],
      acceptanceCriteria: ["GET /metrics returns open request metrics"],
      implementationChecklist: ["add service aggregation", "add route handler"],
      verificationChecklist: [
        "unit test service aggregation",
        "Issue GET /metrics through the public path and assert HTTP 200 plus the JSON response shape"
      ],
      verificationCommands: ["python3 -m unittest tests.generated.test_metrics"]
    }));
    const fakeClient = { setUsageContext: () => {}, complete } as unknown as LLMClient;

    const plan = await new ImplementationPlanner(fakeClient).plan(
      {
        id: "01METRICS-PUBLIC",
        source: "web_form",
        rawContent: "Add GET /metrics with open counts.",
        senderIdentifier: "user@example.com",
        repoFullName: "owner/repo",
        receivedAt: new Date(),
        metadata: {},
        category: "feature_request",
        complexity: "moderate",
        summary: "Add metrics endpoint",
        relevantFiles: ["mosaic_demo/service.py", "mosaic_demo/web.py"],
        confidence: 0.8
      },
      [],
      ["mosaic_demo/service.py", "mosaic_demo/web.py", "tests"]
    );

    expect(complete).toHaveBeenCalledTimes(1);
    expect(plan.verificationChecklist.join("\n")).toContain("public path");
  });
});

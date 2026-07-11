import { describe, expect, it, vi } from "vitest";

import { ImplementationPlanner } from "../packages/pipeline/src/implementation-planner.js";
import { buildClassifiedFeedback, createPipelineLlmClient } from "./helpers/pipeline.js";

describe("ImplementationPlanner", () => {
  it("keeps required files that are in the repo tree or already loaded", async () => {
    const fakeClient = createPipelineLlmClient(async () =>
      JSON.stringify({
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
    );

    const plan = await new ImplementationPlanner(fakeClient).plan(
      buildClassifiedFeedback({
        rawContent: "Fix the service behavior",
        category: "bug_report",
        complexity: "complex",
        summary: "Fix service behavior",
        relevantFiles: ["src/service.ts"],
        confidence: 0.8
      }),
      [{ path: "loaded/generated.ts", content: "export const loaded = true;\n", reason: "loaded context" }],
      ["src/service.ts"]
    );

    expect(plan.requiredFiles).toEqual([
      { path: "src/service.ts", reason: "existing source" },
      { path: "loaded/generated.ts", reason: "already loaded" }
    ]);
  });

  it("repairs an empty non-endpoint plan before generation", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce("{}")
      .mockResolvedValueOnce(JSON.stringify({
        requiredFiles: [{ path: "src/service.ts", reason: "fix the reported behavior" }],
        acceptanceCriteria: ["The reported service behavior is corrected."],
        implementationChecklist: ["Update the service implementation."],
        verificationChecklist: ["Run the focused service tests."],
        verificationCommands: ["pnpm test"]
      }));

    const plan = await new ImplementationPlanner(createPipelineLlmClient(complete)).plan(
      buildClassifiedFeedback({
        rawContent: "Fix the service behavior",
        category: "bug_report",
        complexity: "moderate",
        summary: "Fix the service behavior",
        relevantFiles: ["src/service.ts"],
        confidence: 0.8
      }),
      [],
      ["src/service.ts"]
    );

    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[0]).toContain("Implementation plan must identify at least one required file");
    expect(plan.requiredFiles).toEqual([{ path: "src/service.ts", reason: "fix the reported behavior" }]);
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
    const fakeClient = createPipelineLlmClient(complete);

    const plan = await new ImplementationPlanner(fakeClient).plan(
      buildClassifiedFeedback({
        id: "01METRICS",
        rawContent: "Add GET /metrics with open counts and a stable empty state.",
        category: "feature_request",
        complexity: "moderate",
        summary: "Add support queue metrics endpoint",
        relevantFiles: ["mosaic_demo/service.py", "mosaic_demo/web.py"],
        confidence: 0.8
      }),
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

  it("repairs a full-stack UI plan that omits its backing server surface", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        requiredFiles: [
          { path: "src/settings-form.tsx", reason: "add the settings form UI" }
        ],
        acceptanceCriteria: ["Submitting the form persists settings through the server-side service."],
        implementationChecklist: ["wire the form submit action"],
        verificationChecklist: ["verify the saved value is shown"],
        verificationCommands: []
      }))
      .mockResolvedValueOnce(JSON.stringify({
        requiredFiles: [
          { path: "src/settings-form.tsx", reason: "add the settings form UI and submit action" },
          { path: "src/settings-service.ts", reason: "persist settings in the backing server service" }
        ],
        acceptanceCriteria: ["Submitting the form persists settings through the server-side service."],
        implementationChecklist: ["wire the form submit action", "save settings in the server service"],
        verificationChecklist: ["verify the form calls the service and the saved value is returned"],
        verificationCommands: []
      }));

    const plan = await new ImplementationPlanner(createPipelineLlmClient(complete)).plan(
      buildClassifiedFeedback({
        rawContent: "Add a settings form that persists preferences through the server-side service.",
        category: "feature_request",
        complexity: "moderate",
        summary: "Add persistent account settings UI",
        relevantFiles: ["src/settings-form.tsx", "src/settings-service.ts"],
        confidence: 0.9
      }),
      [],
      ["src/settings-form.tsx", "src/settings-service.ts"]
    );

    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[0]).toContain("Full-stack UI plan must include the backing server/handler/service surface");
    expect(plan.requiredFiles.map((file) => file.path)).toEqual([
      "src/settings-form.tsx",
      "src/settings-service.ts"
    ]);
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
    const fakeClient = createPipelineLlmClient(complete);

    const plan = await new ImplementationPlanner(fakeClient).plan(
      buildClassifiedFeedback({
        id: "01METRICS-PUBLIC",
        rawContent: "Add GET /metrics with open counts.",
        category: "feature_request",
        complexity: "moderate",
        summary: "Add metrics endpoint",
        relevantFiles: ["mosaic_demo/service.py", "mosaic_demo/web.py"],
        confidence: 0.8
      }),
      [],
      ["mosaic_demo/service.py", "mosaic_demo/web.py", "tests"]
    );

    expect(complete).toHaveBeenCalledTimes(1);
    expect(plan.verificationChecklist.join("\n")).toContain("public path");
  });

  it("deterministically completes endpoint verification after an incomplete repair", async () => {
    const incompletePlan = {
      requiredFiles: [
        { path: "mosaic_demo/service.py", reason: "add metrics aggregation" },
        { path: "mosaic_demo/web.py", reason: "add GET /metrics route" },
        { path: "tests/generated/test_metrics.py", reason: "cover service and handler behavior" }
      ],
      acceptanceCriteria: ["GET /metrics returns open request metrics"],
      implementationChecklist: ["add service aggregation", "add route handler"],
      verificationChecklist: ["run the generated metrics checks"],
      verificationCommands: ["python3 -m unittest tests.generated.test_metrics"]
    };
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(incompletePlan))
      .mockResolvedValueOnce(JSON.stringify(incompletePlan));
    const fakeClient = createPipelineLlmClient(complete);

    const plan = await new ImplementationPlanner(fakeClient).plan(
      buildClassifiedFeedback({
        id: "01METRICS-NORMALIZED",
        rawContent: "Add GET /metrics with open counts.",
        category: "feature_request",
        complexity: "moderate",
        summary: "Add metrics endpoint",
        relevantFiles: ["mosaic_demo/service.py", "mosaic_demo/web.py"],
        confidence: 0.8
      }),
      [],
      ["mosaic_demo/service.py", "mosaic_demo/web.py", "tests"]
    );

    expect(complete).toHaveBeenCalledTimes(2);
    expect(plan.verificationChecklist).toContain(
      "Unit test the backing behavior used by /metrics, including its empty-state response."
    );
    expect(plan.verificationChecklist).toContain(
      "Test the public HTTP route for /metrics through the handler and assert its status and response body."
    );
  });
});

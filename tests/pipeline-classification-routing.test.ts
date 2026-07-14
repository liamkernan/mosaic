import { describe, expect, it, vi } from "vitest";

import type { FeedbackItem } from "../packages/core/src/types.js";
import { classifyFeedbackWithOpenAIRouting } from "../packages/pipeline/src/classification-routing.js";
import type { OpenAIModelSelection } from "../packages/pipeline/src/model-routing.js";

const feedbackItem: FeedbackItem = {
  id: "01ROUTING",
  repoFullName: "owner/repo",
  source: "web_form",
  senderIdentifier: "routing@example.com",
  receivedAt: new Date("2026-07-14T00:00:00.000Z"),
  rawContent: "The profile label is wrong.",
  metadata: {}
};

function classification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: "copy_change",
    complexity: "simple",
    summary: "Correct the profile label",
    relevantFiles: ["src/Profile.tsx"],
    confidence: 0.99,
    ...overrides
  };
}

function createFactory(responses: Record<string, unknown>[]): {
  routes: OpenAIModelSelection[];
  createClient: (route: OpenAIModelSelection) => {
    setUsageContext: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
  };
} {
  const routes: OpenAIModelSelection[] = [];
  const queuedResponses = [...responses];
  return {
    routes,
    createClient: (route) => {
      routes.push(route);
      const response = queuedResponses.shift();
      return {
        setUsageContext: vi.fn(),
        complete: vi.fn(async () => JSON.stringify(response))
      };
    }
  };
}

describe("OpenAI production classification routing", () => {
  it("stops after Luna/high when the initial classification is trivial", async () => {
    const factory = createFactory([classification({ complexity: "trivial" })]);

    const result = await classifyFeedbackWithOpenAIRouting({
      feedbackItem,
      fileTree: ["src/Profile.tsx"],
      modelPreset: "quality",
      createClient: factory.createClient
    });

    expect(factory.routes).toEqual([{ model: "gpt-5.6-luna", reasoningEffort: "high" }]);
    expect(result.passes).toHaveLength(1);
    expect(result.classifiedFeedback.complexity).toBe("trivial");
  });

  it.each([
    [
      "simple",
      classification({ complexity: "simple" }),
      { model: "gpt-5.6-terra", reasoningEffort: "high" }
    ],
    [
      "moderate-safe",
      classification({ complexity: "moderate", rawContent: "Correct the profile label text." }),
      { model: "gpt-5.6-terra", reasoningEffort: "xhigh" }
    ],
    [
      "moderate-review-needed",
      classification({ complexity: "moderate", category: "feature_request" }),
      { model: "gpt-5.6-sol", reasoningEffort: "high" }
    ],
    [
      "complex-review-needed",
      classification({ complexity: "complex", category: "feature_request" }),
      { model: "gpt-5.6-sol", reasoningEffort: "xhigh" }
    ]
  ] as const)("reclassifies initial %s work on its selected production tier", async (_name, initial, expectedRoute) => {
    const factory = createFactory([initial, initial]);
    const routedFeedbackItem = {
      ...feedbackItem,
      rawContent: typeof initial.rawContent === "string" ? initial.rawContent : feedbackItem.rawContent
    };

    const result = await classifyFeedbackWithOpenAIRouting({
      feedbackItem: routedFeedbackItem,
      fileTree: ["src/Profile.tsx"],
      modelPreset: "quality",
      createClient: factory.createClient
    });

    expect(factory.routes).toEqual([
      { model: "gpt-5.6-luna", reasoningEffort: "high" },
      expectedRoute
    ]);
    expect(result.passes.map((pass) => pass.route)).toEqual(factory.routes);
    expect(result.classifiedFeedback.complexity).toBe(initial.complexity);
  });

  it("retains the higher initial complexity when routed reclassification downgrades it", async () => {
    const factory = createFactory([
      classification({ complexity: "moderate" }),
      classification({ complexity: "simple" })
    ]);

    const result = await classifyFeedbackWithOpenAIRouting({
      feedbackItem,
      fileTree: ["src/Profile.tsx"],
      modelPreset: "quality",
      createClient: factory.createClient
    });

    expect(result.passes.map((pass) => pass.classifiedFeedback.complexity)).toEqual(["moderate", "simple"]);
    expect(result.classifiedFeedback).toMatchObject({
      complexity: "moderate",
      summary: "Correct the profile label"
    });
  });
});

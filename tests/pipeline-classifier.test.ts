import { describe, expect, it, vi } from "vitest";

import type { FeedbackItem } from "../packages/core/src/types.js";
import { FeedbackClassifier } from "../packages/pipeline/src/classifier.js";

const feedback: FeedbackItem = {
  id: "01CLASSIFY",
  source: "web_form",
  rawContent: "The checkout button is broken.",
  senderIdentifier: "user@example.com",
  repoFullName: "owner/repo",
  receivedAt: new Date("2026-07-01T12:00:00.000Z"),
  metadata: {}
};

describe("FeedbackClassifier", () => {
  it("sets usage context and limits model-selected files", async () => {
    const setUsageContext = vi.fn();
    const complete = vi.fn(async () => JSON.stringify({
      category: "bug_report",
      complexity: "moderate",
      summary: "Fix checkout button",
      relevantFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"],
      confidence: 0.9
    }));

    const result = await new FeedbackClassifier({ setUsageContext, complete }).classify(feedback, ["src/a.ts"]);

    expect(setUsageContext).toHaveBeenCalledWith({ repoFullName: "owner/repo", feedbackId: "01CLASSIFY" });
    expect(complete).toHaveBeenCalledWith(
      expect.stringContaining("The checkout button is broken."),
      "Return only the JSON classification.",
      { temperature: 0.2, maxTokens: 1_024, requestPhase: "classification" }
    );
    expect(result).toMatchObject({
      category: "bug_report",
      complexity: "moderate",
      summary: "Fix checkout button",
      relevantFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
      confidence: 0.9
    });
  });

  it("fails closed after two malformed model responses", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce("still not json");

    const result = await new FeedbackClassifier({ setUsageContext: vi.fn(), complete }).classify(feedback, []);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      category: "other",
      complexity: "complex",
      summary: "Unable to classify feedback safely",
      relevantFiles: [],
      confidence: 0
    });
  });

  it.each([
    [
      "coordinated copy",
      "trivial",
      {
        scope: "coordinated",
        runtimeBehavior: false,
        persistentData: false,
        securitySensitive: false,
        requiresHumanReview: false
      },
      "simple"
    ],
    [
      "multi-component state",
      "simple",
      {
        scope: "multi-component",
        runtimeBehavior: true,
        persistentData: false,
        securitySensitive: false,
        requiresHumanReview: false
      },
      "moderate"
    ],
    [
      "localized semantic change",
      "trivial",
      {
        scope: "localized",
        literalCorrection: false,
        runtimeBehavior: false,
        persistentData: false,
        securitySensitive: false,
        requiresHumanReview: false
      },
      "simple"
    ]
  ] as const)("preserves structured signals and floors under-classified %s", async (_name, complexity, routingSignals, expected) => {
    const complete = vi.fn(async () => JSON.stringify({
      category: "bug_report",
      complexity,
      summary: "Fix the reported behavior",
      relevantFiles: ["src/a.ts", "src/b.ts"],
      confidence: 0.95,
      routingSignals
    }));

    const result = await new FeedbackClassifier({ setUsageContext: vi.fn(), complete }).classify(feedback, [
      "src/a.ts",
      "src/b.ts"
    ]);

    expect(result.complexity).toBe(expected);
    expect(result.routingSignals).toEqual(routingSignals);
  });
});

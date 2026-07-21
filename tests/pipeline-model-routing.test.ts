import { describe, expect, it } from "vitest";

import {
  selectGenerationModelTier,
  selectOpenAIModel,
  selectPlanningModelTier,
  shouldEscalateClassification,
  shouldUseAdvisorTool
} from "../packages/pipeline/src/model-routing.js";
import { buildClassifiedFeedback } from "./helpers/pipeline.js";

const baseFeedback = buildClassifiedFeedback({
  rawContent: "Fix the typo in the hero heading.",
  category: "copy_change",
  complexity: "simple",
  summary: "Fix the typo in the hero heading",
  relevantFiles: ["index.html"],
  confidence: 0.9
});

describe("model routing", () => {
  it("keeps trivial and simple work on haiku", () => {
    expect(
      selectGenerationModelTier({
        ...baseFeedback,
        complexity: "trivial",
        category: "copy_change"
      })
    ).toBe("haiku");
    expect(selectGenerationModelTier(baseFeedback)).toBe("haiku");
    expect(
      shouldEscalateClassification({
        ...baseFeedback,
        complexity: "trivial",
        routingSignals: {
          scope: "localized",
          literalCorrection: true,
          runtimeBehavior: false,
          persistentData: false,
          securitySensitive: false,
          requiresHumanReview: false
        }
      })
    ).toBe(false);
    expect(shouldEscalateClassification(baseFeedback)).toBe(false);
  });

  it("escalates an unproven trivial label for confirmation", () => {
    expect(shouldEscalateClassification({ ...baseFeedback, complexity: "trivial" })).toBe(true);
  });

  it("routes moderate work to sonnet", () => {
    expect(
      selectGenerationModelTier({
        ...baseFeedback,
        complexity: "moderate"
      })
    ).toBe("sonnet");
    expect(
      shouldEscalateClassification({
        ...baseFeedback,
        complexity: "moderate"
      })
    ).toBe(true);
  });

  it("routes complex feature work to Opus in quality mode", () => {
    const complexFeedback = {
      ...baseFeedback,
      category: "feature_request",
      complexity: "complex"
    } as const;

    expect(selectGenerationModelTier(complexFeedback)).toBe("opus");
    expect(
      shouldEscalateClassification(complexFeedback)
    ).toBe(true);
    expect(selectPlanningModelTier(complexFeedback)).toBe("opus");
    expect(shouldUseAdvisorTool(complexFeedback)).toBe(false);
  });

  it("routes moderate feature work to sonnet", () => {
    const moderateFeedback = {
      ...baseFeedback,
      category: "feature_request",
      complexity: "moderate"
    } as const;

    expect(
      selectGenerationModelTier({
        ...baseFeedback,
        category: "feature_request",
        complexity: "moderate"
      })
    ).toBe("sonnet");
    expect(shouldEscalateClassification(moderateFeedback)).toBe(true);
    expect(shouldUseAdvisorTool(moderateFeedback)).toBe(true);
  });

  it("escalates low-confidence classifications", () => {
    expect(
      shouldEscalateClassification({
        ...baseFeedback,
        confidence: 0.6
      })
    ).toBe(true);
  });

  it("escalates when relevant files are unclear", () => {
    expect(
      shouldEscalateClassification({
        ...baseFeedback,
        relevantFiles: []
      })
    ).toBe(true);
  });

  it("escalates non-obvious bug reports", () => {
    expect(
      shouldEscalateClassification({
        ...baseFeedback,
        category: "bug_report",
        rawContent: "The checkout flow feels broken sometimes after adding items to the cart.",
        summary: "Checkout flow breaks after cart interaction"
      })
    ).toBe(true);
  });

  it("keeps obvious bug reports on haiku", () => {
    expect(
      shouldEscalateClassification({
        ...baseFeedback,
        category: "bug_report",
        rawContent: "The living room tile is misaligned with the others.",
        summary: "Living room tile is misaligned"
      })
    ).toBe(false);
  });

  it("keeps simple ui tweaks and obvious bug reports on haiku for generation", () => {
    expect(
      selectGenerationModelTier({
        ...baseFeedback,
        category: "ui_tweak"
      })
    ).toBe("haiku");
    expect(
      selectGenerationModelTier({
        ...baseFeedback,
        category: "bug_report",
        rawContent: "The living room tile is misaligned with the others.",
        summary: "Living room tile is misaligned"
      })
    ).toBe("haiku");
  });

  it("routes non-obvious simple bug reports to sonnet for generation", () => {
    expect(
      selectGenerationModelTier({
        ...baseFeedback,
        category: "bug_report",
        rawContent: "The checkout flow feels broken sometimes after adding items to the cart.",
        summary: "Checkout flow breaks after cart interaction"
      })
    ).toBe("sonnet");
  });

  it("supports frontend model presets for generation and advisor routing", () => {
    const complexFeedback = {
      ...baseFeedback,
      category: "feature_request",
      complexity: "complex"
    } as const;
    const moderateFeedback = {
      ...complexFeedback,
      complexity: "moderate"
    } as const;

    expect(selectGenerationModelTier(complexFeedback, "balanced")).toBe("sonnet");
    expect(selectPlanningModelTier(complexFeedback, "balanced")).toBe("sonnet");
    expect(selectPlanningModelTier(moderateFeedback, "balanced")).toBe("sonnet");
    expect(shouldUseAdvisorTool(complexFeedback, "balanced")).toBe(false);
    expect(shouldUseAdvisorTool(moderateFeedback, "balanced")).toBe(false);

    expect(selectGenerationModelTier(complexFeedback, "quality")).toBe("opus");
    expect(selectPlanningModelTier(complexFeedback, "quality")).toBe("opus");
    expect(selectPlanningModelTier(moderateFeedback, "quality")).toBe("sonnet");
    expect(shouldUseAdvisorTool(complexFeedback, "quality")).toBe(false);
    expect(shouldUseAdvisorTool(moderateFeedback, "quality")).toBe(true);
  });

  it.each([
    ["trivial", undefined, "gpt-5.6-luna", "high"],
    ["simple", undefined, "gpt-5.6-terra", "high"],
    ["moderate", "moderate-safe", "gpt-5.6-terra", "xhigh"],
    ["moderate", "moderate-review-needed", "gpt-5.6-sol", "high"],
    ["complex", "complex-review-needed", "gpt-5.6-sol", "xhigh"]
  ] as const)("routes %s OpenAI quality work", (complexity, issueMode, model, reasoningEffort) => {
    expect(selectOpenAIModel({ ...baseFeedback, complexity }, "quality", issueMode)).toEqual({
      model,
      reasoningEffort
    });
  });

  it("keeps the configured OpenAI tiers when the balanced preset is selected", () => {
    expect(selectOpenAIModel({ ...baseFeedback, complexity: "moderate" }, "balanced", "moderate-safe")).toEqual({
      model: "gpt-5.6-terra",
      reasoningEffort: "xhigh"
    });
  });
});

import { describe, expect, it } from "vitest";

import { selectGenerationModelTier, selectPlanningModelTier, shouldEscalateClassification, shouldUseAdvisorTool } from "../packages/pipeline/src/model-routing.js";

const baseFeedback = {
  id: "01TEST",
  source: "web_form" as const,
  rawContent: "Fix the typo in the hero heading.",
  senderIdentifier: "user@example.com",
  repoFullName: "owner/repo",
  receivedAt: new Date(),
  metadata: {},
  category: "copy_change" as const,
  complexity: "simple" as const,
  summary: "Fix the typo in the hero heading",
  relevantFiles: ["index.html"],
  confidence: 0.9
};

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
        complexity: "trivial"
      })
    ).toBe(false);
    expect(shouldEscalateClassification(baseFeedback)).toBe(false);
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

  it("routes complex feature work to sonnet", () => {
    const complexFeedback = {
      ...baseFeedback,
      category: "feature_request",
      complexity: "complex"
    } as const;

    expect(selectGenerationModelTier(complexFeedback)).toBe("sonnet");
    expect(
      shouldEscalateClassification(complexFeedback)
    ).toBe(true);
    expect(shouldUseAdvisorTool(complexFeedback)).toBe(true);
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
    expect(shouldUseAdvisorTool(moderateFeedback)).toBe(false);
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

    expect(selectGenerationModelTier(complexFeedback, "balanced")).toBe("sonnet");
    expect(selectPlanningModelTier()).toBe("sonnet");
    expect(shouldUseAdvisorTool(complexFeedback, "balanced")).toBe(false);

    expect(selectGenerationModelTier(complexFeedback, "quality")).toBe("sonnet");
    expect(selectPlanningModelTier()).toBe("sonnet");
    expect(shouldUseAdvisorTool(complexFeedback, "quality")).toBe(true);
  });
});

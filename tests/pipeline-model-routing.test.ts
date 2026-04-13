import { describe, expect, it } from "vitest";

import { selectGenerationModelTier, shouldEscalateClassification } from "../packages/pipeline/src/model-routing.js";

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
    expect(selectGenerationModelTier("trivial")).toBe("haiku");
    expect(selectGenerationModelTier("simple")).toBe("haiku");
    expect(
      shouldEscalateClassification({
        ...baseFeedback,
        complexity: "trivial"
      })
    ).toBe(false);
    expect(shouldEscalateClassification(baseFeedback)).toBe(false);
  });

  it("routes moderate work to sonnet", () => {
    expect(selectGenerationModelTier("moderate")).toBe("sonnet");
    expect(
      shouldEscalateClassification({
        ...baseFeedback,
        complexity: "moderate"
      })
    ).toBe(true);
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
});

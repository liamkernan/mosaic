import { describe, expect, it } from "vitest";

import { decideFeedbackDisposition } from "../packages/pipeline/src/disposition.js";
import { defaultRuntimeConfig } from "../packages/pipeline/src/repo-config.js";
import { buildClassifiedFeedback } from "./helpers/pipeline.js";

const baseFeedback = buildClassifiedFeedback({
  rawContent: "Fix the typo in the hero copy.",
  category: "copy_change",
  complexity: "simple",
  summary: "Fix the typo in the hero copy",
  relevantFiles: ["src/hero.tsx"],
  confidence: 0.9
});

describe("feedback disposition", () => {
  it("sends trivial or simple feedback to PR automation", () => {
    const result = decideFeedbackDisposition(baseFeedback, {
      repoFullName: "owner/repo",
      ...defaultRuntimeConfig
    });

    expect(result.disposition).toBe("pr");
  });

  it("routes moderate feedback to issues", () => {
    const result = decideFeedbackDisposition(
      {
        ...baseFeedback,
        complexity: "moderate",
        confidence: 0.95
      },
      {
        repoFullName: "owner/repo",
        ...defaultRuntimeConfig
      }
    );

    expect(result.disposition).toBe("issue");
    expect(result.issueMode).toBe("moderate-safe");
  });

  it("leans moderate feedback toward review-needed issues", () => {
    const result = decideFeedbackDisposition(
      {
        ...baseFeedback,
        category: "feature_request",
        complexity: "moderate",
        confidence: 0.95
      },
      {
        repoFullName: "owner/repo",
        ...defaultRuntimeConfig
      }
    );

    expect(result.disposition).toBe("issue");
    expect(result.issueMode).toBe("moderate-review-needed");
  });

  it("routes complex feedback to issues", () => {
    const result = decideFeedbackDisposition(
      {
        ...baseFeedback,
        complexity: "complex"
      },
      {
        repoFullName: "owner/repo",
        ...defaultRuntimeConfig
      }
    );

    expect(result.disposition).toBe("issue");
    expect(result.reason).toBe("Complex feedback always requires a staged review before implementation.");
    expect(result.issueMode).toBe("complex-review-needed");
  });

  it("stages complex disallowed-category feedback for draft PR promotion", () => {
    const result = decideFeedbackDisposition(
      {
        ...baseFeedback,
        category: "feature_request",
        complexity: "complex"
      },
      {
        repoFullName: "owner/repo",
        ...defaultRuntimeConfig
      }
    );

    expect(result.disposition).toBe("issue");
    expect(result.reason).toBe("This category is not allowed for direct auto-PRs in the repo configuration.");
    expect(result.issueMode).toBe("complex-review-needed");
  });

  it("routes low-confidence simple feedback to issues", () => {
    const result = decideFeedbackDisposition(
      {
        ...baseFeedback,
        confidence: 0.4
      },
      {
        repoFullName: "owner/repo",
        ...defaultRuntimeConfig
      }
    );

    expect(result.disposition).toBe("issue");
  });

  it("requires an existing implementation file before direct automation", () => {
    const result = decideFeedbackDisposition(
      { ...baseFeedback, relevantFiles: [] },
      { repoFullName: "owner/repo", ...defaultRuntimeConfig }
    );

    expect(result).toEqual({
      disposition: "issue",
      reason: "The classifier could not ground this request in an existing repository file.",
      issueMode: undefined
    });
  });

  it("allows moderate-safe work only when the repo explicitly opts into it", () => {
    const result = decideFeedbackDisposition(
      {
        ...baseFeedback,
        complexity: "moderate",
        routingSignals: {
          scope: "multi-component",
          literalCorrection: false,
          runtimeBehavior: true,
          persistentData: false,
          securitySensitive: false,
          requiresHumanReview: false
        }
      },
      {
        repoFullName: "owner/repo",
        ...defaultRuntimeConfig,
        maxComplexity: "moderate"
      }
    );

    expect(result).toEqual({
      disposition: "pr",
      reason: "Moderate-safe feedback is explicitly allowed by the repo's PR automation policy."
    });
  });

  it("never auto-implements explicit review risk even when the declared tier is simple", () => {
    const result = decideFeedbackDisposition(
      {
        ...baseFeedback,
        routingSignals: {
          scope: "localized",
          literalCorrection: false,
          runtimeBehavior: true,
          persistentData: false,
          securitySensitive: false,
          requiresHumanReview: true
        }
      },
      {
        repoFullName: "owner/repo",
        ...defaultRuntimeConfig,
        maxComplexity: "complex"
      }
    );

    expect(result.disposition).toBe("issue");
    expect(result.reason).toContain("require human review");
  });

  it("never auto-implements complex work even when max complexity is complex", () => {
    const result = decideFeedbackDisposition(
      {
        ...baseFeedback,
        complexity: "complex"
      },
      {
        repoFullName: "owner/repo",
        ...defaultRuntimeConfig,
        maxComplexity: "complex"
      }
    );

    expect(result).toMatchObject({ disposition: "issue", issueMode: "complex-review-needed" });
  });
});

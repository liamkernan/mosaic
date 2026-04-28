import { describe, expect, it } from "vitest";

import { decideFeedbackDisposition } from "../packages/pipeline/src/disposition.js";
import { defaultRuntimeConfig } from "../packages/pipeline/src/repo-config.js";

const baseFeedback = {
  id: "01TEST",
  source: "web_form" as const,
  rawContent: "Fix the typo in the hero copy.",
  senderIdentifier: "user@example.com",
  repoFullName: "owner/repo",
  receivedAt: new Date(),
  metadata: {},
  category: "copy_change" as const,
  complexity: "simple" as const,
  summary: "Fix the typo in the hero copy",
  relevantFiles: ["src/hero.tsx"],
  confidence: 0.9
};

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

  it("quarantines complex feedback", () => {
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

    expect(result.disposition).toBe("quarantine");
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
});

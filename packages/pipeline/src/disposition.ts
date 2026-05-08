import type { ClassifiedFeedback } from "@mosaic/core";

import type { RepoRuntimeConfig } from "./repo-config.js";
import { getModerateIssueMode, type StagedIssueMode } from "./staged-issues.js";

const complexityRanking = ["trivial", "simple", "moderate", "complex"] as const;

export type FeedbackDisposition = "pr" | "issue" | "quarantine";

export interface DispositionDecision {
  disposition: FeedbackDisposition;
  reason: string;
  issueMode?: StagedIssueMode;
}

function exceedsComplexity(limit: string, current: string): boolean {
  return complexityRanking.indexOf(current as (typeof complexityRanking)[number]) >
    complexityRanking.indexOf(limit as (typeof complexityRanking)[number]);
}

function getComplexIssueMode(classifiedFeedback: ClassifiedFeedback): StagedIssueMode | undefined {
  return classifiedFeedback.complexity === "complex" ? "complex-review-needed" : undefined;
}

export function decideFeedbackDisposition(
  classifiedFeedback: ClassifiedFeedback,
  repoConfig: RepoRuntimeConfig
): DispositionDecision {
  if (classifiedFeedback.complexity === "moderate") {
    const issueMode = getModerateIssueMode(classifiedFeedback);
    return {
      disposition: "issue",
      reason:
        issueMode === "moderate-safe"
          ? "Moderate feedback was saved as a staged GitHub issue and can be promoted to a PR on request."
          : "Moderate feedback was saved as a staged GitHub issue and requires review before PR promotion.",
      issueMode
    };
  }

  if (classifiedFeedback.confidence < 0.6) {
    return {
      disposition: "issue",
      reason: "Classifier confidence was below the automation threshold.",
      issueMode: getComplexIssueMode(classifiedFeedback)
    };
  }

  if (!repoConfig.allowedCategories.includes(classifiedFeedback.category)) {
    return {
      disposition: "issue",
      reason: "This category is not allowed for direct auto-PRs in the repo configuration.",
      issueMode: getComplexIssueMode(classifiedFeedback)
    };
  }

  if (exceedsComplexity(repoConfig.maxComplexity, classifiedFeedback.complexity)) {
    return {
      disposition: "issue",
      reason: "This feedback exceeds the repo's configured auto-PR complexity threshold.",
      issueMode: getComplexIssueMode(classifiedFeedback)
    };
  }

  return {
    disposition: "pr",
    reason: "Low-complexity feedback passed the PR automation policy."
  };
}

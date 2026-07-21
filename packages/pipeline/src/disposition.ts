import type { ClassifiedFeedback } from "@mosaic/core";

import type { RepoRuntimeConfig } from "./repo-config.js";
import { routingSignalsRequireReview } from "./routing-signals.js";
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

function getIssueMode(classifiedFeedback: ClassifiedFeedback): StagedIssueMode | undefined {
  if (classifiedFeedback.complexity === "moderate") {
    return getModerateIssueMode(classifiedFeedback);
  }

  return getComplexIssueMode(classifiedFeedback);
}

export function decideFeedbackDisposition(
  classifiedFeedback: ClassifiedFeedback,
  repoConfig: RepoRuntimeConfig
): DispositionDecision {
  if (
    classifiedFeedback.routingSignals &&
    routingSignalsRequireReview(classifiedFeedback.routingSignals)
  ) {
    const issueMode = getIssueMode(classifiedFeedback);
    return {
      disposition: "issue",
      reason: "Structured routing signals require human review before this feedback can be automated.",
      ...(issueMode ? { issueMode } : {})
    };
  }

  if (classifiedFeedback.confidence < 0.6) {
    return {
      disposition: "issue",
      reason: "Classifier confidence was below the automation threshold.",
      issueMode: getIssueMode(classifiedFeedback)
    };
  }

  if (classifiedFeedback.relevantFiles.length === 0) {
    return {
      disposition: "issue",
      reason: "The classifier could not ground this request in an existing repository file.",
      issueMode: getIssueMode(classifiedFeedback)
    };
  }

  if (!repoConfig.allowedCategories.includes(classifiedFeedback.category)) {
    return {
      disposition: "issue",
      reason: "This category is not allowed for direct auto-PRs in the repo configuration.",
      issueMode: getIssueMode(classifiedFeedback)
    };
  }

  if (classifiedFeedback.complexity === "complex") {
    return {
      disposition: "issue",
      reason: "Complex feedback always requires a staged review before implementation.",
      issueMode: "complex-review-needed"
    };
  }

  if (exceedsComplexity(repoConfig.maxComplexity, classifiedFeedback.complexity)) {
    return {
      disposition: "issue",
      reason: "This feedback exceeds the repo's configured auto-PR complexity threshold.",
      issueMode: getIssueMode(classifiedFeedback)
    };
  }

  return {
    disposition: "pr",
    reason: classifiedFeedback.complexity === "moderate"
      ? "Moderate-safe feedback is explicitly allowed by the repo's PR automation policy."
      : "Low-complexity feedback passed the PR automation policy."
  };
}

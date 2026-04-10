import type { ClassifiedFeedback } from "@feedbackbot/core";

import type { RepoRuntimeConfig } from "./repo-config.js";

const complexityRanking = ["trivial", "simple", "moderate", "complex"] as const;

export type FeedbackDisposition = "pr" | "issue" | "quarantine";

export interface DispositionDecision {
  disposition: FeedbackDisposition;
  reason: string;
}

function exceedsComplexity(limit: string, current: string): boolean {
  return complexityRanking.indexOf(current as (typeof complexityRanking)[number]) >
    complexityRanking.indexOf(limit as (typeof complexityRanking)[number]);
}

export function decideFeedbackDisposition(
  classifiedFeedback: ClassifiedFeedback,
  repoConfig: RepoRuntimeConfig
): DispositionDecision {
  if (classifiedFeedback.complexity === "complex") {
    return {
      disposition: "quarantine",
      reason: "Complex feedback is quarantined for manual triage instead of creating a GitHub artifact automatically."
    };
  }

  if (classifiedFeedback.complexity === "moderate") {
    return {
      disposition: "issue",
      reason: "Moderate feedback is routed to a GitHub issue for human review."
    };
  }

  if (classifiedFeedback.confidence < 0.6) {
    return {
      disposition: "issue",
      reason: "Classifier confidence was below the automation threshold."
    };
  }

  if (!repoConfig.allowedCategories.includes(classifiedFeedback.category)) {
    return {
      disposition: "issue",
      reason: "This category is not allowed for direct auto-PRs in the repo configuration."
    };
  }

  if (exceedsComplexity(repoConfig.maxComplexity, classifiedFeedback.complexity)) {
    return {
      disposition: "issue",
      reason: "This feedback exceeds the repo's configured auto-PR complexity threshold."
    };
  }

  return {
    disposition: "pr",
    reason: "Low-complexity feedback passed the PR automation policy."
  };
}

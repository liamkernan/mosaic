import { Buffer } from "node:buffer";

import { type ClassifiedFeedback } from "@feedbackbot/core";

export const STAGED_ISSUE_LABEL = "feedbackbot:staged";
export const STAGED_ISSUE_PROMOTED_LABEL = "feedbackbot:pr-opened";
export const MODERATE_SAFE_LABEL = "feedbackbot:moderate-safe";
export const MODERATE_REVIEW_NEEDED_LABEL = "feedbackbot:moderate-review-needed";

const STAGED_ISSUE_METADATA_PREFIX = "feedbackbot:staged-issue";
const fixThisCommandPattern =
  /^\s*(?:@feedbackbot[\s,:-]*)?(?:please\s+)?(?:fix this|implement this|open (?:a )?(?:pr|pull request)|create (?:a )?(?:pr|pull request)|make (?:a )?(?:pr|pull request)|raise (?:a )?(?:pr|pull request))(?:\s+(?:please|now|for me))?\s*[.!?]*\s*$/i;
const safeModeratePattern =
  /\b(typo|copy|text|label|headline|button text|cta|link|spacing|padding|margin|alignment|css|color|placeholder|helper text|empty state)\b/i;

export type ModerateIssueMode = "moderate-safe" | "moderate-review-needed";

export interface StagedIssueMetadata {
  version: 1;
  feedbackId: string;
  repoFullName: string;
  source: ClassifiedFeedback["source"];
  senderIdentifier: string;
  receivedAt: string;
  category: ClassifiedFeedback["category"];
  complexity: "moderate";
  summary: string;
  relevantFiles: string[];
  confidence: number;
  rawContent: string;
  issueMode: ModerateIssueMode;
}

export function getModerateIssueMode(classifiedFeedback: ClassifiedFeedback): ModerateIssueMode {
  const combinedText = `${classifiedFeedback.summary}\n${classifiedFeedback.rawContent}`;
  const looksSafe =
    classifiedFeedback.category !== "feature_request" &&
    classifiedFeedback.category !== "question" &&
    classifiedFeedback.category !== "other" &&
    classifiedFeedback.confidence >= 0.92 &&
    classifiedFeedback.relevantFiles.length > 0 &&
    classifiedFeedback.relevantFiles.length <= 2 &&
    safeModeratePattern.test(combinedText);

  return looksSafe ? "moderate-safe" : "moderate-review-needed";
}

export function buildStagedIssueMetadata(classifiedFeedback: ClassifiedFeedback, issueMode: ModerateIssueMode): StagedIssueMetadata {
  return {
    version: 1,
    feedbackId: classifiedFeedback.id,
    repoFullName: classifiedFeedback.repoFullName,
    source: classifiedFeedback.source,
    senderIdentifier: classifiedFeedback.senderIdentifier,
    receivedAt: classifiedFeedback.receivedAt.toISOString(),
    category: classifiedFeedback.category,
    complexity: "moderate",
    summary: classifiedFeedback.summary,
    relevantFiles: classifiedFeedback.relevantFiles,
    confidence: classifiedFeedback.confidence,
    rawContent: classifiedFeedback.rawContent,
    issueMode
  };
}

export function buildStagedIssueMetadataComment(metadata: StagedIssueMetadata): string {
  const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64");
  return `<!-- ${STAGED_ISSUE_METADATA_PREFIX} ${encoded} -->`;
}

export function parseStagedIssueMetadata(body: string): StagedIssueMetadata | null {
  const match = body.match(new RegExp(`<!--\\s*${STAGED_ISSUE_METADATA_PREFIX}\\s+([^\\s]+)\\s*-->`));
  if (!match) {
    return null;
  }

  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as StagedIssueMetadata;
    if (parsed.version !== 1 || parsed.complexity !== "moderate") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function isFixThisCommand(input: string): boolean {
  return fixThisCommandPattern.test(input);
}

export function getIssueModeLabel(issueMode: ModerateIssueMode): string {
  return issueMode === "moderate-safe" ? MODERATE_SAFE_LABEL : MODERATE_REVIEW_NEEDED_LABEL;
}

export function getPromotionDescription(issueMode: ModerateIssueMode): string {
  return issueMode === "moderate-safe"
    ? "Comment `fix this`, `implement this`, or `open PR` to ask FeedbackBot to open a pull request from this issue."
    : "Comment `fix this`, `implement this`, or `open PR` to ask FeedbackBot to open a draft pull request from this issue.";
}

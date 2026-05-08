import { Buffer } from "node:buffer";

import { getEnv, type ClassifiedFeedback } from "@mosaic/core";

export const STAGED_ISSUE_LABEL = "mosaic:staged";
export const STAGED_ISSUE_PROMOTED_LABEL = "mosaic:pr-opened";
export const MODERATE_SAFE_LABEL = "mosaic:moderate-safe";
export const MODERATE_REVIEW_NEEDED_LABEL = "mosaic:moderate-review-needed";
export const COMPLEX_REVIEW_NEEDED_LABEL = "mosaic:complex-review-needed";

const STAGED_ISSUE_METADATA_PREFIX = "mosaic:staged-issue";
const safeModeratePattern =
  /\b(typo|copy|text|label|headline|button text|cta|link|spacing|padding|margin|alignment|css|color|placeholder|helper text|empty state)\b/i;

export type StagedIssueMode = "moderate-safe" | "moderate-review-needed" | "complex-review-needed";

export interface StagedIssueMetadata {
  version: 1;
  feedbackId: string;
  repoFullName: string;
  source: ClassifiedFeedback["source"];
  senderIdentifier: string;
  receivedAt: string;
  category: ClassifiedFeedback["category"];
  complexity: ClassifiedFeedback["complexity"];
  summary: string;
  relevantFiles: string[];
  confidence: number;
  rawContent: string;
  issueMode: StagedIssueMode;
}

export function getModerateIssueMode(classifiedFeedback: ClassifiedFeedback): StagedIssueMode {
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

export function buildStagedIssueMetadata(classifiedFeedback: ClassifiedFeedback, issueMode: StagedIssueMode): StagedIssueMetadata {
  const receivedAt = classifiedFeedback.receivedAt instanceof Date
    ? classifiedFeedback.receivedAt.toISOString()
    : new Date(classifiedFeedback.receivedAt).toISOString();

  return {
    version: 1,
    feedbackId: classifiedFeedback.id,
    repoFullName: classifiedFeedback.repoFullName,
    source: classifiedFeedback.source,
    senderIdentifier: classifiedFeedback.senderIdentifier,
    receivedAt,
    category: classifiedFeedback.category,
    complexity: classifiedFeedback.complexity,
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
    if (parsed.version !== 1 || !["moderate", "complex"].includes(parsed.complexity)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function getTriggerPhrases(): string[] {
  return [...new Set([getEnv().MOSAIC_TRIGGER_PHRASE ?? "@mosaic", "@mosaic"])];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isFixThisCommand(input: string): boolean {
  const trigger = getTriggerPhrases().map(escapeRegExp).join("|");
  const pattern = new RegExp(
    `^\\s*(?:${trigger})[\\s,:-]*(?:please\\s+)?(?:fix this|implement this|open (?:a )?(?:pr|pull request)|create (?:a )?(?:pr|pull request)|make (?:a )?(?:pr|pull request)|raise (?:a )?(?:pr|pull request))(?:\\s+(?:please|now|for me))?\\s*[.!?]*\\s*$`,
    "i"
  );
  return pattern.test(input);
}

export function getIssueModeLabel(issueMode: StagedIssueMode): string {
  if (issueMode === "moderate-safe") {
    return MODERATE_SAFE_LABEL;
  }

  return issueMode === "complex-review-needed" ? COMPLEX_REVIEW_NEEDED_LABEL : MODERATE_REVIEW_NEEDED_LABEL;
}

export function getPromotionDescription(issueMode: StagedIssueMode): string {
  const trigger = getEnv().MOSAIC_TRIGGER_PHRASE ?? "@mosaic";

  return issueMode === "moderate-safe"
    ? `Comment \`${trigger} fix this\`, \`${trigger} implement this\`, or \`${trigger} open PR\` to ask Mosaic to open a pull request from this issue.`
    : `Comment \`${trigger} fix this\`, \`${trigger} implement this\`, or \`${trigger} open PR\` to ask Mosaic to open a draft pull request from this issue.`;
}

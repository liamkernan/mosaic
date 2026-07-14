import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

import { ConfigError, getEnv, type ClassificationRoutingSignals, type ClassifiedFeedback } from "@mosaic/core";

import { isClassificationRoutingSignals, routingSignalsRequireReview } from "./routing-signals.js";

export const STAGED_ISSUE_LABEL = "mosaic:staged";
export const STAGED_ISSUE_PROMOTED_LABEL = "mosaic:pr-opened";
export const MODERATE_SAFE_LABEL = "mosaic:moderate-safe";
export const MODERATE_REVIEW_NEEDED_LABEL = "mosaic:moderate-review-needed";
export const COMPLEX_REVIEW_NEEDED_LABEL = "mosaic:complex-review-needed";

const STAGED_ISSUE_METADATA_PREFIX = "mosaic:staged-issue";
const stagedIssueMetadataPattern = /<!--\s*mosaic:staged-issue\s+v1\s+([A-Za-z0-9_-]+)\s+([a-f0-9]{64})\s*-->/g;
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
  routingSignals?: ClassificationRoutingSignals;
}

export function getModerateIssueMode(classifiedFeedback: ClassifiedFeedback): StagedIssueMode {
  if (classifiedFeedback.routingSignals) {
    return routingSignalsRequireReview(classifiedFeedback.routingSignals)
      ? "moderate-review-needed"
      : "moderate-safe";
  }

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
    issueMode,
    ...(classifiedFeedback.routingSignals ? { routingSignals: classifiedFeedback.routingSignals } : {})
  };
}

function resolveStagedIssueSecret(): string {
  const env = getEnv();
  const secret = env.MOSAIC_STAGED_ISSUE_SECRET ?? env.MOSAIC_INTAKE_SHARED_SECRET ?? env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    throw new ConfigError("MOSAIC_STAGED_ISSUE_SECRET, MOSAIC_INTAKE_SHARED_SECRET, or GITHUB_WEBHOOK_SECRET is required for staged issue metadata");
  }

  return secret;
}

function signEncodedMetadata(encoded: string, secret: string): string {
  return createHmac("sha256", secret).update(encoded).digest("hex");
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isStagedIssueMetadata(value: unknown): value is StagedIssueMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as Partial<StagedIssueMetadata>;
  return metadata.version === 1 &&
    typeof metadata.feedbackId === "string" &&
    typeof metadata.repoFullName === "string" &&
    typeof metadata.source === "string" &&
    typeof metadata.senderIdentifier === "string" &&
    typeof metadata.receivedAt === "string" &&
    typeof metadata.category === "string" &&
    ["moderate", "complex"].includes(metadata.complexity ?? "") &&
    typeof metadata.summary === "string" &&
    Array.isArray(metadata.relevantFiles) &&
    metadata.relevantFiles.every((filePath) => typeof filePath === "string") &&
    typeof metadata.confidence === "number" &&
    typeof metadata.rawContent === "string" &&
    ["moderate-safe", "moderate-review-needed", "complex-review-needed"].includes(metadata.issueMode ?? "") &&
    (metadata.routingSignals === undefined || isClassificationRoutingSignals(metadata.routingSignals));
}

export function buildStagedIssueMetadataComment(metadata: StagedIssueMetadata, secret = resolveStagedIssueSecret()): string {
  const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
  const signature = signEncodedMetadata(encoded, secret);
  return `<!-- ${STAGED_ISSUE_METADATA_PREFIX} v1 ${encoded} ${signature} -->`;
}

export function parseStagedIssueMetadata(body: string, secret?: string): StagedIssueMetadata | null {
  const matches = [...body.matchAll(stagedIssueMetadataPattern)];
  if (matches.length === 0) {
    return null;
  }

  const signingSecret = secret ?? resolveStagedIssueSecret();
  let parsedMetadata: StagedIssueMetadata | null = null;
  for (const match of matches) {
    const [, encoded, signature] = match;
    const expectedSignature = signEncodedMetadata(encoded, signingSecret);
    if (!constantTimeEquals(signature, expectedSignature)) {
      continue;
    }

    try {
      const decoded = Buffer.from(encoded, "base64url").toString("utf8");
      const parsed = JSON.parse(decoded) as unknown;
      if (isStagedIssueMetadata(parsed)) {
        parsedMetadata = parsed;
      }
    } catch {
      continue;
    }
  }

  return parsedMetadata;
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

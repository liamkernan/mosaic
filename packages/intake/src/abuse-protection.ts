import { createHash } from "node:crypto";

import { AbuseDetectedError, type FeedbackItem } from "@mosaic/core";
import type { Redis } from "ioredis";

const MAX_SUBMISSIONS_PER_SENDER_PER_HOUR = 10;
const DUPLICATE_WINDOW_SECONDS = 24 * 60 * 60;
const repeatedCharacterPattern = /(.)\1{9,}/i;
const suspiciousPhrasePatterns = [
  /ignore (all )?previous instructions/i,
  /system prompt/i,
  /developer message/i,
  /rm -rf/i,
  /drop table/i,
  /execsync?\(/i,
  /child_process/i,
  /sudo\s+/i,
  /<script\b/i,
  /buy now/i,
  /free money/i,
  /casino/i,
  /viagra/i
];

export interface AbuseAssessment {
  accepted: boolean;
  reasons: string[];
}

function isLoopbackAddress(value: unknown): boolean {
  return typeof value === "string" && (
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1" ||
    value === "localhost"
  );
}

function isLocalWebhookRetry(feedbackItem: FeedbackItem): boolean {
  return feedbackItem.source === "web_form" && isLoopbackAddress(feedbackItem.metadata.ip);
}

function contentFingerprint(rawContent: string): string {
  return createHash("sha256")
    .update(rawContent.toLowerCase().replace(/\s+/g, " ").trim())
    .digest("hex");
}

function countUrls(rawContent: string): number {
  return (rawContent.match(/https?:\/\/[^\s]+/g) ?? []).length;
}

export function assessFeedbackContent(rawContent: string): AbuseAssessment {
  const reasons: string[] = [];

  if (countUrls(rawContent) > 3) {
    reasons.push("contains too many external URLs");
  }

  if (repeatedCharacterPattern.test(rawContent)) {
    reasons.push("contains repeated-character spam");
  }

  for (const pattern of suspiciousPhrasePatterns) {
    if (pattern.test(rawContent)) {
      reasons.push(`matched suspicious pattern: ${pattern.source}`);
    }
  }

  return {
    accepted: reasons.length === 0,
    reasons
  };
}

export async function enforceSubmissionProtection(feedbackItem: FeedbackItem, redis: Redis): Promise<void> {
  const assessment = assessFeedbackContent(feedbackItem.rawContent);
  if (!assessment.accepted) {
    throw new AbuseDetectedError(`Submission rejected: ${assessment.reasons.join("; ")}`);
  }

  const senderBucket = new Date().toISOString().slice(0, 13);
  const senderKey = `sender-rate:${feedbackItem.repoFullName}:${feedbackItem.senderIdentifier}:${senderBucket}`;
  const senderCount = await redis.incr(senderKey);
  if (senderCount === 1) {
    await redis.expire(senderKey, 3600);
  }
  if (senderCount > MAX_SUBMISSIONS_PER_SENDER_PER_HOUR) {
    throw new AbuseDetectedError("Submission rejected: sender exceeded hourly submission limit");
  }

  if (isLocalWebhookRetry(feedbackItem)) {
    return;
  }

  const fingerprintKey = `feedback-dedupe:${feedbackItem.repoFullName}:${contentFingerprint(feedbackItem.rawContent)}`;
  const dedupeSet = await redis.set(fingerprintKey, feedbackItem.id, "EX", DUPLICATE_WINDOW_SECONDS, "NX");
  if (dedupeSet !== "OK") {
    throw new AbuseDetectedError("Submission rejected: duplicate feedback already received recently");
  }
}

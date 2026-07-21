import sanitizeHtml from "sanitize-html";
import { ValidationError, repoFullNamePattern, type FeedbackItem, type FeedbackSource } from "@mosaic/core";
import { ulid } from "ulid";

interface BaseAdapterOutput {
  message?: string;
  rawContent?: string;
  repoFullName?: string;
  senderIdentifier?: string;
  metadata?: Record<string, unknown>;
  receivedAt?: string | Date;
  subject?: string;
  text?: string;
  senderEmail?: string;
  username?: string;
  userId?: string;
}

function stripHtml(input: string): string {
  if (!/[<&]/.test(input)) {
    return input.trim();
  }

  return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} }).trim();
}

function truncate(input: string, maxLength: number): string {
  return input.length <= maxLength ? input : input.slice(0, maxLength);
}

function feedbackContent(payload: BaseAdapterOutput, source: FeedbackSource): string {
  const primarySource = payload.rawContent ?? payload.message ?? payload.text ?? payload.subject ?? "";
  const primary = stripHtml(String(primarySource));
  if (source !== "email" || !payload.subject || primarySource === payload.subject) {
    return primary;
  }

  const subject = stripHtml(payload.subject)
    .replace(/\[repo:[^\]]+\]/gi, "")
    .trim()
    .slice(0, 500);
  if (!subject || /^feedback submission$/i.test(subject) || primary.toLowerCase().startsWith(subject.toLowerCase())) {
    return primary;
  }

  return `Subject: ${subject}\n\n${primary}`;
}

function resolveRepoFullName(payload: BaseAdapterOutput): string {
  const direct = payload.repoFullName?.trim();
  if (direct) {
    return direct;
  }

  const subject = payload.subject ?? payload.rawContent ?? payload.message ?? "";
  const taggedRepo = subject.match(/\[repo:([^\]]+)\]/i)?.[1]?.trim();
  if (taggedRepo) {
    return taggedRepo;
  }

  throw new ValidationError("Missing repoFullName");
}

export function normalize(adapterOutput: unknown, source: FeedbackSource): FeedbackItem {
  if (!adapterOutput || typeof adapterOutput !== "object") {
    throw new ValidationError("Adapter output must be an object");
  }

  const payload = adapterOutput as BaseAdapterOutput;
  const repoFullName = resolveRepoFullName(payload);
  if (!repoFullNamePattern.test(repoFullName)) {
    throw new ValidationError(`Invalid repoFullName: ${repoFullName}`);
  }

  const rawContent = truncate(feedbackContent(payload, source), 5_000);
  if (!rawContent) {
    throw new ValidationError("Feedback content is empty after normalization");
  }

  return {
    id: ulid(),
    source,
    rawContent,
    senderIdentifier:
      payload.senderIdentifier ??
      payload.senderEmail ??
      payload.username ??
      payload.userId ??
      "unknown",
    repoFullName,
    receivedAt: payload.receivedAt ? new Date(payload.receivedAt) : new Date(),
    metadata: payload.metadata ?? {}
  };
}

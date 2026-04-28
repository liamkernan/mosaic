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
  return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} }).trim();
}

function truncate(input: string, maxLength: number): string {
  return input.length <= maxLength ? input : input.slice(0, maxLength);
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

  const rawContentSource = payload.rawContent ?? payload.message ?? payload.text ?? payload.subject ?? "";
  const rawContent = truncate(stripHtml(String(rawContentSource)), 5_000);
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

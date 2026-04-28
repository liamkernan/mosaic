import type { FeedbackItem } from "@mosaic/core";

export const MAX_LLM_REQUEUE_ATTEMPTS = 3;

const RETRY_COUNT_KEY = "__llmRetryCount";

export function isRetryableLlmOverload(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const errorLike = error as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  const code = errorLike.code !== undefined ? String(errorLike.code) : undefined;
  const name = errorLike.name !== undefined ? String(errorLike.name) : undefined;
  if (code !== "LLM_ERROR" && name !== "LLMError") {
    return false;
  }

  const causeStatus =
    typeof errorLike.cause === "object" && errorLike.cause && "status" in errorLike.cause
      ? Number((errorLike.cause as { status?: unknown }).status)
      : undefined;
  const message = errorLike.message !== undefined ? String(errorLike.message).toLowerCase() : "";

  return causeStatus === 529 || (message.includes("529") && message.includes("overloaded"));
}

export function getLlmRetryCount(feedbackItem: FeedbackItem): number {
  const rawCount = feedbackItem.metadata[RETRY_COUNT_KEY];
  return typeof rawCount === "number" && Number.isInteger(rawCount) && rawCount >= 0 ? rawCount : 0;
}

export function buildLlmRetryFeedbackItem(feedbackItem: FeedbackItem): FeedbackItem {
  return {
    ...feedbackItem,
    metadata: {
      ...feedbackItem.metadata,
      [RETRY_COUNT_KEY]: getLlmRetryCount(feedbackItem) + 1
    }
  };
}

export function getLlmRetryDelayMs(feedbackItem: FeedbackItem): number {
  const retryCount = getLlmRetryCount(feedbackItem);
  return 60_000 * 2 ** retryCount;
}

export function canRetryLlmOverload(feedbackItem: FeedbackItem): boolean {
  return getLlmRetryCount(feedbackItem) < MAX_LLM_REQUEUE_ATTEMPTS;
}

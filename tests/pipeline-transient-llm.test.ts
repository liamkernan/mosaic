import { describe, expect, it } from "vitest";

import { LLMError, type FeedbackItem } from "../packages/core/src/index.js";
import {
  buildLlmRetryFeedbackItem,
  canRetryLlmOverload,
  getLlmRetryCount,
  getLlmRetryDelayMs,
  isRetryableLlmOverload,
  MAX_LLM_REQUEUE_ATTEMPTS
} from "../packages/pipeline/src/transient-llm.js";

function makeFeedbackItem(metadata: Record<string, unknown> = {}): FeedbackItem {
  return {
    id: "01TEST",
    source: "web_form",
    rawContent: "Fix typo",
    senderIdentifier: "user@example.com",
    repoFullName: "owner/repo",
    receivedAt: new Date(),
    metadata
  };
}

describe("transient llm helpers", () => {
  it("detects retryable overloaded Anthropic errors", () => {
    const error = new LLMError("Anthropic completion failed: 529 overloaded");

    expect(isRetryableLlmOverload(error)).toBe(true);
  });

  it("increments retry metadata and calculates delay", () => {
    const feedbackItem = buildLlmRetryFeedbackItem(makeFeedbackItem());

    expect(getLlmRetryCount(feedbackItem)).toBe(1);
    expect(getLlmRetryDelayMs(feedbackItem)).toBe(120_000);
  });

  it("stops retrying after the max retry count", () => {
    const feedbackItem = makeFeedbackItem({ __llmRetryCount: MAX_LLM_REQUEUE_ATTEMPTS });

    expect(canRetryLlmOverload(feedbackItem)).toBe(false);
  });
});

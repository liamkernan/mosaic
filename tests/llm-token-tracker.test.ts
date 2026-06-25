import { describe, expect, it } from "vitest";

import { summarizeFeedbackUsageRecords } from "../packages/llm/src/token-tracker.js";

function usageRecord(feedbackId: string, inputTokens: number, outputTokens: number): string {
  return JSON.stringify({
    repoFullName: "owner/repo",
    feedbackId,
    inputTokens,
    outputTokens,
    model: "test-model",
    timestamp: Date.parse("2026-06-01T00:00:00.000Z")
  });
}

describe("token tracker", () => {
  it("aggregates one feedback item across Redis month buckets without counting other feedback", () => {
    const usage = summarizeFeedbackUsageRecords(
      [
        [
          usageRecord("target", 10, 4),
          usageRecord("other", 100, 100)
        ],
        [
          usageRecord("target", 8, 3),
          usageRecord("other", 50, 25)
        ]
      ],
      "target"
    );

    expect(usage).toEqual({
      inputTokens: 18,
      outputTokens: 7
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import type { ClassifiedFeedback } from "../packages/core/src/types.js";
import { QuarantineStore } from "../packages/pipeline/src/quarantine.js";

describe("QuarantineStore", () => {
  it("stores bounded feedback and trims the repository queue", async () => {
    const lpush = vi.fn(async (_key: string, _value: string) => 1);
    const ltrim = vi.fn(async (_key: string, _start: number, _stop: number) => "OK" as const);
    const feedback: ClassifiedFeedback = {
      id: "01QUARANTINE",
      source: "web_form",
      rawContent: "x".repeat(2_500),
      senderIdentifier: "user@example.com",
      repoFullName: "owner/repo",
      receivedAt: new Date("2026-07-01T12:00:00.000Z"),
      metadata: {},
      category: "other",
      complexity: "complex",
      summary: "Unsafe feedback",
      relevantFiles: [],
      confidence: 0.1
    };

    await new QuarantineStore({ lpush, ltrim }).quarantine(feedback, "unsafe content");

    expect(lpush).toHaveBeenCalledTimes(1);
    const [key, serialized] = lpush.mock.calls[0] ?? [];
    expect(key).toBe("feedback-quarantine:owner/repo");
    expect(JSON.parse(serialized ?? "{}")).toMatchObject({
      feedbackId: "01QUARANTINE",
      repoFullName: "owner/repo",
      reason: "unsafe content",
      rawContent: "x".repeat(2_000)
    });
    expect(ltrim).toHaveBeenCalledWith("feedback-quarantine:owner/repo", 0, 199);
  });
});

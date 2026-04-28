import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  streamMock,
  finalMessageMock,
  enforceRepoRateLimitMock,
  trackUsageMock
} = vi.hoisted(() => ({
  streamMock: vi.fn(),
  finalMessageMock: vi.fn(),
  enforceRepoRateLimitMock: vi.fn(async () => {}),
  trackUsageMock: vi.fn(async () => {})
}));

vi.mock("../packages/llm/src/anthropic.js", () => ({
  createAnthropicClient: vi.fn(() => ({
    messages: {
      stream: streamMock
    }
  }))
}));

vi.mock("../packages/llm/src/rate-limiter.js", () => ({
  enforceRepoRateLimit: enforceRepoRateLimitMock
}));

vi.mock("../packages/llm/src/token-tracker.js", () => ({
  trackUsage: trackUsageMock
}));

import { LLMClient } from "../packages/llm/src/client.js";

describe("LLMClient", () => {
  beforeEach(() => {
    streamMock.mockReset();
    finalMessageMock.mockReset();
    enforceRepoRateLimitMock.mockClear();
    trackUsageMock.mockClear();
    finalMessageMock.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 1,
        output_tokens: 1
      }
    });
    streamMock.mockReturnValue({
      finalMessage: finalMessageMock
    });
  });

  it("omits per-request timeout when none is provided", async () => {
    const client = new LLMClient({
      mode: "platform",
      platformApiKey: "test-key"
    });

    await client.complete("system", "user");

    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        system: "system"
      }),
      undefined
    );
  });

  it("passes per-request timeout when provided", async () => {
    const client = new LLMClient({
      mode: "platform",
      platformApiKey: "test-key"
    });

    await client.complete("system", "user", { timeoutMs: 1234 });

    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        system: "system"
      }),
      { timeout: 1234 }
    );
  });
});

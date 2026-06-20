import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  streamMock,
  betaStreamMock,
  finalMessageMock,
  enforceRepoRateLimitMock,
  trackUsageMock
} = vi.hoisted(() => ({
  streamMock: vi.fn(),
  betaStreamMock: vi.fn(),
  finalMessageMock: vi.fn(),
  enforceRepoRateLimitMock: vi.fn(async () => {}),
  trackUsageMock: vi.fn(async () => {})
}));

vi.mock("../packages/llm/src/anthropic.js", () => ({
  createAnthropicClient: vi.fn(() => ({
    messages: {
      stream: streamMock
    },
    beta: {
      messages: {
        stream: betaStreamMock
      }
    }
  }))
}));

vi.mock("../packages/llm/src/rate-limiter.js", () => ({
  enforceRepoRateLimit: enforceRepoRateLimitMock
}));

vi.mock("../packages/llm/src/token-tracker.js", () => ({
  trackUsage: trackUsageMock
}));

import { ANTHROPIC_ADVISOR_MODEL_ID, ANTHROPIC_ADVISOR_TOOL_BETA, LLMClient } from "../packages/llm/src/client.js";

describe("LLMClient", () => {
  beforeEach(() => {
    streamMock.mockReset();
    betaStreamMock.mockReset();
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
    betaStreamMock.mockReturnValue({
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

  it("uses beta messages with the advisor tool when configured", async () => {
    const client = new LLMClient({
      mode: "platform",
      platformApiKey: "test-key",
      advisorTool: {
        model: ANTHROPIC_ADVISOR_MODEL_ID,
        maxUses: 1
      }
    });

    await client.complete("system", "user");

    expect(streamMock).not.toHaveBeenCalled();
    expect(betaStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        system: "system",
        betas: [ANTHROPIC_ADVISOR_TOOL_BETA],
        tools: [
          {
            type: "advisor_20260301",
            name: "advisor",
            model: "claude-opus-4-8",
            max_uses: 1
          }
        ]
      }),
      undefined
    );
  });

  it("can disable Redis-backed rate limits and usage tracking for local evals", async () => {
    const client = new LLMClient({
      mode: "platform",
      platformApiKey: "test-key",
      disableUsageTracking: true
    });
    client.setUsageContext({
      repoFullName: "owner/repo",
      feedbackId: "01TEST"
    });

    await client.complete("system", "user");

    expect(enforceRepoRateLimitMock).not.toHaveBeenCalled();
    expect(trackUsageMock).not.toHaveBeenCalled();
  });

  it("rejects when the final streamed message exceeds the hard timeout", async () => {
    finalMessageMock.mockReturnValue(new Promise(() => {}));
    const client = new LLMClient({
      mode: "platform",
      platformApiKey: "test-key"
    });

    await expect(client.complete("system", "user", { timeoutMs: 5 })).rejects.toThrow("timed out");
  });
});

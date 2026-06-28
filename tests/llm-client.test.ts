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

  it("falls back to a normal messages request when the advisor model is unavailable", async () => {
    finalMessageMock.mockRejectedValueOnce(
      Object.assign(new Error("advisor model claude-opus-4-8 is unavailable"), {
        status: 404,
        name: "NotFoundError"
      })
    );
    const client = new LLMClient({
      mode: "platform",
      platformApiKey: "test-key",
      advisorTool: {
        model: ANTHROPIC_ADVISOR_MODEL_ID,
        maxUses: 1
      }
    });

    await expect(client.complete("system", "user")).resolves.toBe("ok");

    expect(betaStreamMock).toHaveBeenCalledTimes(1);
    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        system: "system"
      }),
      undefined
    );
    expect(finalMessageMock).toHaveBeenCalledTimes(2);
  });

  it("does not fall back for unrelated beta request failures", async () => {
    finalMessageMock.mockRejectedValueOnce(
      Object.assign(new Error("malformed request body"), {
        status: 400,
        name: "BadRequestError"
      })
    );
    const client = new LLMClient({
      mode: "platform",
      platformApiKey: "test-key",
      advisorTool: {
        model: ANTHROPIC_ADVISOR_MODEL_ID,
        maxUses: 1
      }
    });

    await expect(client.complete("system", "user")).rejects.toThrow("malformed request body");

    expect(betaStreamMock).toHaveBeenCalledTimes(1);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("can disable Redis-backed rate limits and usage tracking for local evals", async () => {
    const observeUsage = vi.fn();
    const client = new LLMClient({
      mode: "platform",
      platformApiKey: "test-key",
      disableUsageTracking: true,
      observeUsage
    });
    client.setUsageContext({
      repoFullName: "owner/repo",
      feedbackId: "01TEST"
    });

    await client.complete("system", "user");

    expect(enforceRepoRateLimitMock).not.toHaveBeenCalled();
    expect(trackUsageMock).not.toHaveBeenCalled();
    expect(observeUsage).toHaveBeenCalledWith(expect.objectContaining({
      model: "claude-sonnet-4-6",
      inputTokens: 1,
      outputTokens: 1,
      retries: 0,
      advisorOffered: false,
      advisorUsed: false
    }));
  });

  it("reports executor and advisor usage iterations with their billed models", async () => {
    finalMessageMock.mockResolvedValueOnce({
      content: [
        { type: "tool_use", id: "tool-1", name: "advisor", input: {} },
        { type: "text", text: "ok" }
      ],
      usage: {
        input_tokens: 412,
        output_tokens: 531,
        iterations: [
          {
            type: "message",
            input_tokens: 412,
            output_tokens: 89,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 31
          },
          {
            type: "advisor_message",
            model: ANTHROPIC_ADVISOR_MODEL_ID,
            input_tokens: 823,
            output_tokens: 1_612,
            cache_read_input_tokens: 17,
            cache_creation_input_tokens: 0
          },
          {
            type: "message",
            input_tokens: 1_348,
            output_tokens: 442,
            cache_read_input_tokens: 412,
            cache_creation_input_tokens: 0
          }
        ]
      }
    });
    const observeUsage = vi.fn();
    const client = new LLMClient({
      mode: "platform",
      platformApiKey: "test-key",
      advisorTool: {
        model: ANTHROPIC_ADVISOR_MODEL_ID,
        maxUses: 1,
        maxTokens: 2_048
      },
      disableUsageTracking: true,
      observeUsage
    });

    await client.complete("system", "user");

    expect(observeUsage).toHaveBeenCalledWith(expect.objectContaining({
      advisorUsed: true,
      iterations: [
        {
          type: "message",
          model: "claude-sonnet-4-6",
          inputTokens: 412,
          outputTokens: 89,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 31
        },
        {
          type: "advisor_message",
          model: ANTHROPIC_ADVISOR_MODEL_ID,
          inputTokens: 823,
          outputTokens: 1_612,
          cacheReadInputTokens: 17,
          cacheCreationInputTokens: 0
        },
        {
          type: "message",
          model: "claude-sonnet-4-6",
          inputTokens: 1_348,
          outputTokens: 442,
          cacheReadInputTokens: 412,
          cacheCreationInputTokens: 0
        }
      ]
    }));
  });

  it("checks a local budget before starting an API request", async () => {
    const authorizeRequest = vi.fn(() => {
      throw new Error("local eval budget exhausted");
    });
    const client = new LLMClient({
      mode: "platform",
      platformApiKey: "test-key",
      authorizeRequest
    });

    await expect(client.complete("system", "user", { maxTokens: 100 })).rejects.toThrow("budget exhausted");

    expect(authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      model: "claude-sonnet-4-6",
      maxOutputTokens: 100
    }));
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("joins text response blocks while ignoring non-text blocks", async () => {
    finalMessageMock.mockResolvedValueOnce({
      content: [
        { type: "text", text: "first" },
        { type: "tool_use", id: "tool-1", name: "advisor", input: {} },
        { type: "text", text: "second" }
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 2
      }
    });
    const client = new LLMClient({
      mode: "platform",
      platformApiKey: "test-key",
      disableUsageTracking: true
    });

    await expect(client.complete("system", "user")).resolves.toBe("first\nsecond");
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

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as OpenAIClientModule from "../packages/llm/src/openai.js";

const {
  streamMock,
  betaStreamMock,
  finalMessageMock,
  responsesCreateMock,
  createOpenAIClientMock,
  enforceRepoRateLimitMock,
  trackUsageMock
} = vi.hoisted(() => ({
  streamMock: vi.fn(),
  betaStreamMock: vi.fn(),
  finalMessageMock: vi.fn(),
  responsesCreateMock: vi.fn(),
  createOpenAIClientMock: vi.fn(),
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

vi.mock("../packages/llm/src/openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof OpenAIClientModule>();
  return {
    ...actual,
    createOpenAIClient: createOpenAIClientMock.mockImplementation(() => ({
      responses: {
        create: responsesCreateMock
      }
    }))
  };
});

vi.mock("../packages/llm/src/rate-limiter.js", () => ({
  enforceRepoRateLimit: enforceRepoRateLimitMock
}));

vi.mock("../packages/llm/src/token-tracker.js", () => ({
  trackUsage: trackUsageMock
}));

import {
  ANTHROPIC_ADVISOR_MAX_TOKENS,
  ANTHROPIC_ADVISOR_MODEL_ID,
  ANTHROPIC_ADVISOR_TOOL_BETA,
  ANTHROPIC_MODEL_IDS,
  OPENAI_MODEL_IDS,
  LLMClient,
  resolveOpenAIRequestTimeoutMs
} from "../packages/llm/src/client.js";
import { resolveOpenAIBaseURL } from "../packages/llm/src/openai.js";

describe("LLMClient", () => {
  beforeEach(() => {
    streamMock.mockReset();
    betaStreamMock.mockReset();
    finalMessageMock.mockReset();
    enforceRepoRateLimitMock.mockClear();
    trackUsageMock.mockClear();
    responsesCreateMock.mockReset();
    createOpenAIClientMock.mockClear();
    responsesCreateMock.mockResolvedValue({
      output_text: "openai ok",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 2 }
      }
    });
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

  it.each([
    ANTHROPIC_MODEL_IDS.sonnet,
    ANTHROPIC_MODEL_IDS.opus
  ])("omits unsupported temperature for current Anthropic model %s", async (model) => {
    const client = new LLMClient({
      mode: "platform",
      platformApiKey: "test-key",
      model
    });

    await client.complete("system", "user");

    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model,
        system: "system"
      }),
      undefined
    );
    expect(streamMock.mock.calls[0]?.[0]).not.toHaveProperty("temperature");
  });

  it("retains sampling temperature for older Anthropic models", async () => {
    const client = new LLMClient({
      mode: "platform",
      platformApiKey: "test-key",
      model: ANTHROPIC_MODEL_IDS.haiku
    });

    await client.complete("system", "user", { temperature: 0.4 });

    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: ANTHROPIC_MODEL_IDS.haiku,
        temperature: 0.4
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
        maxUses: 1,
        maxTokens: ANTHROPIC_ADVISOR_MAX_TOKENS
      }
    });

    await client.complete("system", "user");

    expect(streamMock).not.toHaveBeenCalled();
    expect(betaStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-5",
        system: "system",
        betas: [ANTHROPIC_ADVISOR_TOOL_BETA],
        tools: [
          {
            type: "advisor_20260301",
            name: "advisor",
            model: "claude-opus-4-8",
            max_uses: 1,
            max_tokens: 2_048
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
    const authorizeRequest = vi.fn()
      .mockResolvedValueOnce("advisor-attempt")
      .mockResolvedValueOnce("fallback-attempt");
    const observeUsage = vi.fn();
    const client = new LLMClient({
      mode: "platform",
      platformApiKey: "test-key",
      advisorTool: {
        model: ANTHROPIC_ADVISOR_MODEL_ID,
        maxUses: 1
      },
      authorizeRequest,
      observeUsage
    });

    await expect(client.complete("system", "user")).resolves.toBe("ok");

    expect(betaStreamMock).toHaveBeenCalledTimes(1);
    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-5",
        system: "system"
      }),
      undefined
    );
    expect(finalMessageMock).toHaveBeenCalledTimes(2);
    expect(authorizeRequest).toHaveBeenCalledTimes(2);
    expect(observeUsage).toHaveBeenCalledWith(expect.objectContaining({
      authorizationId: "fallback-attempt"
    }));
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
      model: "claude-sonnet-5",
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
          model: "claude-sonnet-5",
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
          model: "claude-sonnet-5",
          inputTokens: 1_348,
          outputTokens: 442,
          cacheReadInputTokens: 412,
          cacheCreationInputTokens: 0
        }
      ]
    }));
  });

  it("fails closed when advisor use has no billable usage iteration", async () => {
    finalMessageMock.mockResolvedValueOnce({
      content: [
        { type: "tool_use", id: "tool-1", name: "advisor", input: {} },
        { type: "text", text: "ok" }
      ],
      usage: {
        input_tokens: 412,
        output_tokens: 531
      }
    });
    const client = new LLMClient({
      mode: "platform",
      platformApiKey: "test-key",
      advisorTool: {
        model: ANTHROPIC_ADVISOR_MODEL_ID,
        maxUses: 1,
        maxTokens: 2_048
      },
      disableUsageTracking: true,
      observeUsage: vi.fn()
    });

    await expect(client.complete("system", "user")).rejects.toThrow("omitted advisor usage iterations");
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
      model: "claude-sonnet-5",
      estimatedInputTokens: 4,
      maxOutputTokens: 100
    }));
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("waits for durable async authorization before starting an API request", async () => {
    let resolveAuthorization: ((value: string) => void) | undefined;
    const authorizeRequest = vi.fn(() => new Promise<string>((resolve) => {
      resolveAuthorization = resolve;
    }));
    const observeUsage = vi.fn();
    const client = new LLMClient({
      mode: "platform",
      platformApiKey: "test-key",
      authorizeRequest,
      observeUsage
    });

    const completion = client.complete("system", "user");
    await vi.waitFor(() => expect(authorizeRequest).toHaveBeenCalledTimes(1));
    expect(streamMock).not.toHaveBeenCalled();

    resolveAuthorization?.("durable-request");
    await expect(completion).resolves.toBe("ok");
    expect(observeUsage).toHaveBeenCalledWith(expect.objectContaining({
      authorizationId: "durable-request"
    }));
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

  it("fails closed when Sonnet 5 returns a refusal stop reason", async () => {
    finalMessageMock.mockResolvedValueOnce({
      content: [],
      stop_reason: "refusal",
      usage: { input_tokens: 10, output_tokens: 1 }
    });
    const authorizeRequest = vi.fn(() => "refused-request");
    const observeUsage = vi.fn();
    const client = new LLMClient({
      mode: "platform",
      platformApiKey: "test-key",
      authorizeRequest,
      observeUsage
    });

    await expect(client.complete("system", "user")).rejects.toThrow("refused by the model safety system");
    expect(observeUsage).toHaveBeenCalledWith(expect.objectContaining({
      authorizationId: "refused-request",
      inputTokens: 10,
      outputTokens: 1
    }));
  });

  it("maps completions directly to the stateless OpenAI Responses API", async () => {
    const observeUsage = vi.fn();
    const authorizeRequest = vi.fn((_request: unknown) => "openai-request-1");
    const client = new LLMClient({
      provider: "openai",
      mode: "platform",
      platformApiKey: "openai-test-key",
      model: OPENAI_MODEL_IDS.sol,
      reasoningEffort: "high",
      advisorTool: {
        model: ANTHROPIC_ADVISOR_MODEL_ID,
        maxUses: 1
      },
      disableUsageTracking: true,
      authorizeRequest,
      observeUsage
    });

    await expect(client.complete("system", "user", { maxTokens: 900, timeoutMs: 1234 })).resolves.toBe("openai ok");

    expect(createOpenAIClientMock).toHaveBeenCalledWith("openai-test-key");
    expect(responsesCreateMock).toHaveBeenCalledWith({
      model: "gpt-5.6-sol",
      instructions: "system",
      input: "user",
      max_output_tokens: 900,
      reasoning: { effort: "high" },
      text: { verbosity: "low" },
      store: false
    }, { timeout: 300_000 });
    expect(authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5.6-sol",
      maxOutputTokens: 900
    }));
    expect(authorizeRequest.mock.calls[0]?.[0]).not.toHaveProperty("advisorModel");
    expect(observeUsage).toHaveBeenCalledWith(expect.objectContaining({
      authorizationId: "openai-request-1",
      model: "gpt-5.6-sol",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 2,
      advisorOffered: false,
      advisorUsed: false,
      iterations: [{
        type: "message",
        model: "gpt-5.6-sol",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 0
      }]
    }));
  });

  it("settles only the successful OpenAI retry authorization", async () => {
    vi.useFakeTimers();
    try {
      responsesCreateMock
        .mockRejectedValueOnce(Object.assign(new Error("rate limit"), {
          status: 429,
          name: "RateLimitError"
        }))
        .mockResolvedValueOnce({
          output_text: "openai ok",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            input_tokens_details: { cached_tokens: 2 }
          }
        });
      const authorizeRequest = vi.fn()
        .mockReturnValueOnce("unknown-attempt")
        .mockReturnValueOnce("successful-attempt");
      const observeUsage = vi.fn();
      const client = new LLMClient({
        provider: "openai",
        mode: "platform",
        platformApiKey: "openai-test-key",
        model: OPENAI_MODEL_IDS.sol,
        disableUsageTracking: true,
        authorizeRequest,
        observeUsage
      });

      const completion = client.complete("system", "user");
      await vi.runAllTimersAsync();
      await expect(completion).resolves.toBe("openai ok");

      expect(authorizeRequest).toHaveBeenCalledTimes(2);
      expect(observeUsage).toHaveBeenCalledWith(expect.objectContaining({
        authorizationId: "successful-attempt",
        retries: 1
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults OpenAI to GPT-5.4 when no model is supplied", async () => {
    const client = new LLMClient({
      provider: "openai",
      mode: "byok",
      apiKey: "repo-openai-key",
      disableUsageTracking: true
    });

    await client.complete("system", "user");

    expect(createOpenAIClientMock).toHaveBeenCalledWith("repo-openai-key");
    expect(responsesCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.6-terra", store: false }),
      undefined
    );
  });

  it("configures the OpenAI SDK with an Azure OpenAI v1 base URL", async () => {
    const client = new LLMClient({
      provider: "openai",
      mode: "platform",
      platformApiKey: "azure-openai-key",
      openAIBaseURL: "https://mosaicopenai.openai.azure.com/openai/v1/",
      model: OPENAI_MODEL_IDS.sol,
      disableUsageTracking: true
    });

    await client.complete("system", "user");

    expect(createOpenAIClientMock).toHaveBeenCalledWith("azure-openai-key", {
      baseURL: "https://mosaicopenai.openai.azure.com/openai/v1/"
    });
    expect(responsesCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.6-sol" }),
      undefined
    );
  });

  it("applies OpenAI minimum output token and timeout floors to requests and budget authorization", async () => {
    const authorizeRequest = vi.fn();
    const client = new LLMClient({
      provider: "openai",
      mode: "platform",
      platformApiKey: "azure-openai-key",
      model: "gpt-5-mini",
      openAIMinOutputTokens: 16_384,
      openAIMinTimeoutMs: 300_000,
      disableUsageTracking: true,
      authorizeRequest
    });

    await client.complete("system", "user", { maxTokens: 1_024, timeoutMs: 45_000 });

    expect(responsesCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5-mini",
        max_output_tokens: 16_384
      }),
      { timeout: 300_000 }
    );
    expect(authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5-mini",
      maxOutputTokens: 16_384
    }));
  });

  it.each([
    ["high", 45_000, undefined, 300_000],
    ["xhigh", 180_000, undefined, 480_000],
    ["xhigh", 600_000, undefined, 600_000],
    ["xhigh", 180_000, 540_000, 540_000]
  ] as const)(
    "applies the automatic Sol/%s timeout floor without lowering explicit limits",
    (reasoningEffort, requestTimeoutMs, configuredMinTimeoutMs, expectedTimeoutMs) => {
      expect(resolveOpenAIRequestTimeoutMs(
        OPENAI_MODEL_IDS.sol,
        reasoningEffort,
        requestTimeoutMs,
        configuredMinTimeoutMs
      )).toBe(expectedTimeoutMs);
    }
  );

  it("leaves non-Sol OpenAI routes on their requested timeout", () => {
    expect(resolveOpenAIRequestTimeoutMs(
      OPENAI_MODEL_IDS.terra,
      "xhigh",
      45_000,
      undefined
    )).toBe(45_000);
    expect(resolveOpenAIRequestTimeoutMs(
      OPENAI_MODEL_IDS.luna,
      "high",
      undefined,
      undefined
    )).toBeUndefined();
  });

  it("does not apply OpenAI timeout configuration to Anthropic requests", async () => {
    const client = new LLMClient({
      provider: "anthropic",
      mode: "platform",
      platformApiKey: "anthropic-test-key",
      model: ANTHROPIC_MODEL_IDS.sonnet,
      reasoningEffort: "xhigh",
      openAIMinTimeoutMs: 480_000
    });

    await client.complete("system", "user", { timeoutMs: 1_234 });

    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: ANTHROPIC_MODEL_IDS.sonnet }),
      { timeout: 1_234 }
    );
  });

  it("normalizes unsupported none reasoning to minimal for Azure GPT-5 mini deployments", async () => {
    const client = new LLMClient({
      provider: "openai",
      mode: "platform",
      platformApiKey: "azure-openai-key",
      openAIBaseURL: "https://mosaicopenai.openai.azure.com/openai/v1/",
      model: "gpt-5-mini",
      reasoningEffort: "none",
      disableUsageTracking: true
    });

    await client.complete("system", "user");

    expect(responsesCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5-mini",
        reasoning: { effort: "minimal" }
      }),
      undefined
    );
  });

  it.each([
    [undefined, "https://mosaicopenai.openai.azure.com/", "https://mosaicopenai.openai.azure.com/openai/v1/"],
    [undefined, "https://mosaicopenai.openai.azure.com/openai/v1", "https://mosaicopenai.openai.azure.com/openai/v1/"],
    ["https://proxy.example.test/openai/v1", "https://mosaicopenai.openai.azure.com/", "https://proxy.example.test/openai/v1/"]
  ])("normalizes OpenAI base URLs for Azure endpoint config", (baseURL, azureEndpoint, expected) => {
    expect(resolveOpenAIBaseURL(baseURL, azureEndpoint)).toBe(expected);
  });

  it("records usage and rejects partial OpenAI output when max_output_tokens is reached", async () => {
    responsesCreateMock.mockResolvedValueOnce({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output_text: "<changes><change>truncated",
      usage: {
        input_tokens: 2_000,
        output_tokens: 8_192,
        input_tokens_details: { cached_tokens: 500 }
      }
    });
    const observeUsage = vi.fn();
    const client = new LLMClient({
      provider: "openai",
      mode: "platform",
      platformApiKey: "openai-test-key",
      model: OPENAI_MODEL_IDS.sol,
      disableUsageTracking: true,
      observeUsage
    });

    await expect(client.complete("system", "user", { maxTokens: 8_192 }))
      .rejects.toThrow("OpenAI response incomplete: max_output_tokens after 8192 output tokens");

    expect(responsesCreateMock).toHaveBeenCalledTimes(1);
    expect(observeUsage).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 2_000,
      outputTokens: 8_192,
      retries: 0
    }));
  });
});

import type Anthropic from "@anthropic-ai/sdk";
import { LLMError, type LLMKeyMode, logger } from "@mosaic/core";

import { createAnthropicClient } from "./anthropic.js";
import { enforceRepoRateLimit } from "./rate-limiter.js";
import { trackUsage } from "./token-tracker.js";

export const ANTHROPIC_MODEL_IDS = {
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001"
} as const;

export const ANTHROPIC_ADVISOR_MODEL_ID = "claude-opus-4-8";
export const ANTHROPIC_ADVISOR_TOOL_BETA = "advisor-tool-2026-03-01";

const ANTHROPIC_ADVISOR_TOOL_TYPE = "advisor_20260301";
const ANTHROPIC_ADVISOR_TOOL_NAME = "advisor";

export interface AdvisorToolOptions {
  model: string;
  maxUses?: number;
  maxTokens?: number;
}

export interface LLMClientOptions {
  mode: LLMKeyMode;
  apiKey?: string;
  platformApiKey?: string;
  model?: string;
  advisorTool?: AdvisorToolOptions;
  disableUsageTracking?: boolean;
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface UsageContext {
  repoFullName: string;
  feedbackId: string;
}

type TextContentBlock = {
  type: "text";
  text: string;
};

type AdvisorToolDefinition = {
  type: typeof ANTHROPIC_ADVISOR_TOOL_TYPE;
  name: typeof ANTHROPIC_ADVISOR_TOOL_NAME;
  model: string;
  max_uses?: number;
  max_tokens?: number;
};

type BetaMessageStreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

function withHardTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) {
    return promise;
  }

  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new LLMError(`Anthropic completion timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function buildAdvisorToolDefinition(options: AdvisorToolOptions): AdvisorToolDefinition {
  return {
    type: ANTHROPIC_ADVISOR_TOOL_TYPE,
    name: ANTHROPIC_ADVISOR_TOOL_NAME,
    model: options.model,
    ...(options.maxUses === undefined ? {} : { max_uses: options.maxUses }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens })
  };
}

function isTextContentBlock(item: unknown): item is TextContentBlock {
  return typeof item === "object" &&
    item !== null &&
    "type" in item &&
    item.type === "text" &&
    "text" in item &&
    typeof item.text === "string";
}

export class LLMClient {
  private readonly client: Anthropic;
  private readonly defaultModel: string;
  private readonly advisorTool?: AdvisorToolOptions;
  private readonly disableUsageTracking: boolean;
  private usageContext?: UsageContext;

  constructor({ mode, apiKey, platformApiKey, model, advisorTool, disableUsageTracking = false }: LLMClientOptions) {
    const resolvedApiKey = mode === "byok" ? apiKey : platformApiKey;
    if (!resolvedApiKey) {
      throw new LLMError(`Missing API key for LLM mode: ${mode}`);
    }

    this.client = createAnthropicClient(resolvedApiKey);
    this.defaultModel = model ?? ANTHROPIC_MODEL_IDS.sonnet;
    this.advisorTool = advisorTool;
    this.disableUsageTracking = disableUsageTracking;
  }

  setUsageContext(context: UsageContext): void {
    this.usageContext = context;
  }

  async complete(systemPrompt: string, userMessage: string, options: CompletionOptions = {}): Promise<string> {
    const maxRetries = 3;
    let attempt = 0;
    const model = this.defaultModel;

    while (attempt < maxRetries) {
      try {
        if (this.usageContext && !this.disableUsageTracking) {
          await enforceRepoRateLimit(this.usageContext.repoFullName);
        }

        const request = {
          model,
          system: systemPrompt,
          max_tokens: options.maxTokens ?? 4096,
          temperature: options.temperature ?? 0.2,
          messages: [{ role: "user" as const, content: userMessage }]
        };
        const requestOptions = options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : undefined;
        const stream = this.advisorTool
          ? this.client.beta.messages.stream(
              {
                ...request,
                betas: [ANTHROPIC_ADVISOR_TOOL_BETA],
                tools: [buildAdvisorToolDefinition(this.advisorTool)]
              } as unknown as BetaMessageStreamParams,
              requestOptions
            )
          : this.client.messages.stream(request, requestOptions);
        const response = await withHardTimeout(stream.finalMessage(), options.timeoutMs);

        const text = response.content
          .flatMap((item) => isTextContentBlock(item) ? [item.text] : [])
          .join("\n");

        if (this.usageContext && response.usage && !this.disableUsageTracking) {
          await trackUsage({
            ...this.usageContext,
            model,
            inputTokens: response.usage.input_tokens ?? 0,
            outputTokens: response.usage.output_tokens ?? 0,
            timestamp: Date.now()
          });
        }

        return text.trim();
      } catch (error) {
        attempt += 1;
        const status = typeof error === "object" && error && "status" in error ? Number(error.status) : undefined;
        const errorName = typeof error === "object" && error && "name" in error ? String(error.name) : undefined;
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (status === 429 && attempt < maxRetries) {
          const delayMs = 2 ** attempt * 1_000;
          logger.warn({ attempt, delayMs }, "Anthropic rate limit hit, retrying");
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        const details = [
          status ? `status ${status}` : undefined,
          errorName,
          errorMessage
        ].filter(Boolean).join(": ");

        throw new LLMError(details ? `Anthropic completion failed (${details})` : "Anthropic completion failed", {
          cause: error as Error
        });
      }
    }

    throw new LLMError("Anthropic completion failed after retries");
  }
}

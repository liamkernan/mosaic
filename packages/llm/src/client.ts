import type Anthropic from "@anthropic-ai/sdk";
import { LLMError, type LLMKeyMode, logger } from "@mosaic/core";

import { createAnthropicClient } from "./anthropic.js";
import { enforceRepoRateLimit } from "./rate-limiter.js";
import { trackUsage } from "./token-tracker.js";

export const ANTHROPIC_MODEL_IDS = {
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001"
} as const;

export interface LLMClientOptions {
  mode: LLMKeyMode;
  apiKey?: string;
  platformApiKey?: string;
  model?: string;
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

export class LLMClient {
  private readonly client: Anthropic;
  private readonly defaultModel: string;
  private readonly disableUsageTracking: boolean;
  private usageContext?: UsageContext;

  constructor({ mode, apiKey, platformApiKey, model, disableUsageTracking = false }: LLMClientOptions) {
    const resolvedApiKey = mode === "byok" ? apiKey : platformApiKey;
    if (!resolvedApiKey) {
      throw new LLMError(`Missing API key for LLM mode: ${mode}`);
    }

    this.client = createAnthropicClient(resolvedApiKey);
    this.defaultModel = model ?? ANTHROPIC_MODEL_IDS.sonnet;
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

        const stream = this.client.messages.stream(
          {
            model,
            system: systemPrompt,
            max_tokens: options.maxTokens ?? 4096,
            temperature: options.temperature ?? 0.2,
            messages: [{ role: "user", content: userMessage }]
          },
          options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : undefined
        );
        const response = await withHardTimeout(stream.finalMessage(), options.timeoutMs);

        const text = response.content
          .filter((item): item is Anthropic.TextBlock => item.type === "text")
          .map((item) => item.text)
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

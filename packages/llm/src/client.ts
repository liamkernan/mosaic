import Anthropic from "@anthropic-ai/sdk";
import { LLMError, type LLMKeyMode, logger } from "@feedbackbot/core";

import { createAnthropicClient } from "./anthropic.js";
import { enforceRepoRateLimit } from "./rate-limiter.js";
import { trackUsage } from "./token-tracker.js";

const MODEL = "claude-sonnet-4-20250514";

export interface LLMClientOptions {
  mode: LLMKeyMode;
  apiKey?: string;
  platformApiKey?: string;
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface UsageContext {
  repoFullName: string;
  feedbackId: string;
}

export class LLMClient {
  private readonly client: Anthropic;
  private usageContext?: UsageContext;

  constructor({ mode, apiKey, platformApiKey }: LLMClientOptions) {
    const resolvedApiKey = mode === "byok" ? apiKey : platformApiKey;
    if (!resolvedApiKey) {
      throw new LLMError(`Missing API key for LLM mode: ${mode}`);
    }

    this.client = createAnthropicClient(resolvedApiKey);
  }

  setUsageContext(context: UsageContext): void {
    this.usageContext = context;
  }

  async complete(systemPrompt: string, userMessage: string, options: CompletionOptions = {}): Promise<string> {
    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        if (this.usageContext) {
          await enforceRepoRateLimit(this.usageContext.repoFullName);
        }

        const response = await this.client.messages.create({
          model: MODEL,
          system: systemPrompt,
          max_tokens: options.maxTokens ?? 4096,
          temperature: options.temperature ?? 0.2,
          messages: [{ role: "user", content: userMessage }]
        });

        const text = response.content
          .filter((item): item is Anthropic.TextBlock => item.type === "text")
          .map((item) => item.text)
          .join("\n");

        if (this.usageContext && response.usage) {
          await trackUsage({
            ...this.usageContext,
            model: MODEL,
            inputTokens: response.usage.input_tokens ?? 0,
            outputTokens: response.usage.output_tokens ?? 0,
            timestamp: Date.now()
          });
        }

        return text.trim();
      } catch (error) {
        attempt += 1;
        const status = typeof error === "object" && error && "status" in error ? Number(error.status) : undefined;
        if (status === 429 && attempt < maxRetries) {
          const delayMs = 2 ** attempt * 1_000;
          logger.warn({ attempt, delayMs }, "Anthropic rate limit hit, retrying");
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        throw new LLMError("Anthropic completion failed", { cause: error as Error });
      }
    }

    throw new LLMError("Anthropic completion failed after retries");
  }
}

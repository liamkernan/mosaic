import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_TIMEOUT_MS = 90_000;

export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    maxRetries: 0,
    timeout: DEFAULT_TIMEOUT_MS
  });
}

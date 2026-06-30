import OpenAI from "openai";

const DEFAULT_TIMEOUT_MS = 90_000;

export function createOpenAIClient(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    maxRetries: 0,
    timeout: DEFAULT_TIMEOUT_MS
  });
}

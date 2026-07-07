import OpenAI from "openai";

const DEFAULT_TIMEOUT_MS = 90_000;

export interface OpenAIClientOptions {
  baseURL?: string;
}

export function resolveOpenAIBaseURL(baseURL?: string, azureEndpoint?: string): string | undefined {
  const explicitBaseURL = baseURL?.trim();
  if (explicitBaseURL) {
    return explicitBaseURL.endsWith("/") ? explicitBaseURL : `${explicitBaseURL}/`;
  }

  const endpoint = azureEndpoint?.trim();
  if (!endpoint) {
    return undefined;
  }

  const normalizedEndpoint = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
  return normalizedEndpoint.endsWith("/openai/v1")
    ? `${normalizedEndpoint}/`
    : `${normalizedEndpoint}/openai/v1/`;
}

export function createOpenAIClient(apiKey: string, options: OpenAIClientOptions = {}): OpenAI {
  return new OpenAI({
    apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    maxRetries: 0,
    timeout: DEFAULT_TIMEOUT_MS
  });
}

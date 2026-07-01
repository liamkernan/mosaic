import type { CompletionOptions } from "@mosaic/llm";

export interface PipelineLlmClient {
  setUsageContext(context: { repoFullName: string; feedbackId: string }): void;
  complete(systemPrompt: string, userMessage: string, options?: CompletionOptions): Promise<string>;
}

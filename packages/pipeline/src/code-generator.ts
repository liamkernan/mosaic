import { LLMError, type ClassifiedFeedback, type GeneratedChange, type RelevantFile } from "@mosaic/core";
import type { LLMClient } from "@mosaic/llm";

import { parseGeneratedChanges } from "./generated-change-parser.js";
import { buildGenerationPrompt } from "./prompts/generate.prompt.js";
import { buildGenerationRepairPrompt, buildValidationRepairPrompt } from "./prompts/repair-generate.prompt.js";

const GENERATION_TIMEOUT_MS = 180_000;

function estimateGenerationMaxTokens(relevantFiles: RelevantFile[]): number {
  const totalBytes = relevantFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  const estimatedTokens = Math.ceil(totalBytes / 3) + 2_048;
  return Math.max(4_096, Math.min(16_384, estimatedTokens));
}

export class CodeGenerator {
  constructor(private readonly llmClient: LLMClient) {}

  private toGeneratedChanges(
    parsed: Array<{ filePath: string; modifiedContent: string; explanation: string }>,
    relevantFiles: RelevantFile[]
  ): GeneratedChange[] {
    const originals = new Map(relevantFiles.map((file) => [file.path, file.content]));

    return parsed
      .map((change) => ({
        filePath: change.filePath,
        originalContent: originals.get(change.filePath) ?? "",
        modifiedContent: change.modifiedContent,
        explanation: change.explanation
      }))
      .filter((change) => change.originalContent !== change.modifiedContent);
  }

  async generate(
    feedback: ClassifiedFeedback,
    relevantFiles: RelevantFile[],
    fileTree: string[]
  ): Promise<GeneratedChange[]> {
    this.llmClient.setUsageContext({
      repoFullName: feedback.repoFullName,
      feedbackId: feedback.id
    });

    const maxTokens = estimateGenerationMaxTokens(relevantFiles);

    const response = await this.llmClient.complete(
      buildGenerationPrompt(feedback.summary, relevantFiles, fileTree),
      "Return only the <changes> payload with complete file contents in CDATA blocks.",
      {
        temperature: 0.3,
        maxTokens,
        timeoutMs: GENERATION_TIMEOUT_MS
      }
    );

    let parsed;
    try {
      parsed = parseGeneratedChanges(response);
    } catch (error) {
      if (!(error instanceof LLMError)) {
        throw error;
      }

      const repairedResponse = await this.llmClient.complete(
        buildGenerationRepairPrompt(response),
        "Return only the repaired <changes> payload with complete file contents in CDATA blocks.",
        {
          temperature: 0,
          maxTokens,
          timeoutMs: GENERATION_TIMEOUT_MS
        }
      );

      parsed = parseGeneratedChanges(repairedResponse);
    }

    return this.toGeneratedChanges(parsed, relevantFiles);
  }

  async repairValidationFailure(
    feedback: ClassifiedFeedback,
    relevantFiles: RelevantFile[],
    fileTree: string[],
    currentChanges: GeneratedChange[],
    validationErrors: string[]
  ): Promise<GeneratedChange[]> {
    this.llmClient.setUsageContext({
      repoFullName: feedback.repoFullName,
      feedbackId: feedback.id
    });

    const maxTokens = estimateGenerationMaxTokens(relevantFiles);
    const response = await this.llmClient.complete(
      buildValidationRepairPrompt(feedback.summary, relevantFiles, currentChanges, validationErrors, fileTree),
      "Return only the repaired <changes> payload with complete file contents in CDATA blocks.",
      {
        temperature: 0,
        maxTokens,
        timeoutMs: GENERATION_TIMEOUT_MS
      }
    );

    return this.toGeneratedChanges(parseGeneratedChanges(response), relevantFiles);
  }
}

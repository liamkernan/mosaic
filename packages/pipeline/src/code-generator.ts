import { LLMError, type ClassifiedFeedback, type GeneratedChange, type RelevantFile } from "@mosaic/core";
import type { LLMClient } from "@mosaic/llm";

import { parseGeneratedChanges } from "./generated-change-parser.js";
import { buildGenerationPrompt } from "./prompts/generate.prompt.js";
import { buildGenerationRepairPrompt } from "./prompts/repair-generate.prompt.js";

export class CodeGenerator {
  constructor(private readonly llmClient: LLMClient) {}

  async generate(
    feedback: ClassifiedFeedback,
    relevantFiles: RelevantFile[],
    fileTree: string[]
  ): Promise<GeneratedChange[]> {
    this.llmClient.setUsageContext({
      repoFullName: feedback.repoFullName,
      feedbackId: feedback.id
    });

    const response = await this.llmClient.complete(
      buildGenerationPrompt(feedback.summary, relevantFiles, fileTree),
      "Return only the JSON array of file updates.",
      {
        temperature: 0.3,
        maxTokens: feedback.complexity === "moderate" ? 16_384 : 12_288
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
        "Return only the repaired JSON array.",
        {
          temperature: 0,
          maxTokens: feedback.complexity === "moderate" ? 16_384 : 12_288
        }
      );

      parsed = parseGeneratedChanges(repairedResponse);
    }

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
}

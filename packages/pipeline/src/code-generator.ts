import { LLMError, type ClassifiedFeedback, type GeneratedChange, type RelevantFile } from "@feedbackbot/core";
import { LLMClient } from "@feedbackbot/llm";

import { buildGenerationPrompt } from "./prompts/generate.prompt.js";

interface GeneratedChangeResponse {
  filePath: string;
  modifiedContent: string;
  explanation: string;
}

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
        maxTokens: feedback.complexity === "moderate" ? 8_192 : 4_096
      }
    );

    let parsed: GeneratedChangeResponse[];
    try {
      parsed = JSON.parse(response) as GeneratedChangeResponse[];
    } catch (error) {
      throw new LLMError("Code generation returned invalid JSON", { cause: error as Error });
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

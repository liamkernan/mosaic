import {
  type ClassifiedFeedback,
  type FeedbackCategory,
  type FeedbackItem,
  type ComplexityLevel
} from "@mosaic/core";
import type { LLMClient } from "@mosaic/llm";

import { buildClassificationPrompt } from "./prompts/classify.prompt.js";

interface ClassifierResponse {
  category: FeedbackCategory;
  complexity: ComplexityLevel;
  summary: string;
  relevantFiles: string[];
  confidence: number;
}

export class FeedbackClassifier {
  constructor(private readonly llmClient: LLMClient) {}

  async classify(item: FeedbackItem, fileTree: string[]): Promise<ClassifiedFeedback> {
    this.llmClient.setUsageContext({
      repoFullName: item.repoFullName,
      feedbackId: item.id
    });

    const systemPrompt = buildClassificationPrompt(item.rawContent, fileTree);

    let parsed: ClassifierResponse | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.llmClient.complete(systemPrompt, "Return only the JSON classification.", {
        temperature: 0.2,
        maxTokens: 1_024
      });

      try {
        parsed = JSON.parse(response) as ClassifierResponse;
        break;
      } catch {
        parsed = undefined;
      }
    }

    if (!parsed) {
      return {
        ...item,
        category: "other",
        complexity: "complex",
        summary: "Unable to classify feedback safely",
        relevantFiles: [],
        confidence: 0
      };
    }

    return {
      ...item,
      category: parsed.category,
      complexity: parsed.complexity,
      summary: parsed.summary,
      relevantFiles: parsed.relevantFiles.slice(0, 5),
      confidence: parsed.confidence
    };
  }
}

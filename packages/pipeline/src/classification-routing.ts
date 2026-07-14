import type { ClassifiedFeedback, FeedbackItem, LLMModelPreset } from "@mosaic/core";
import { OPENAI_MODEL_IDS } from "@mosaic/llm";

import { FeedbackClassifier } from "./classifier.js";
import {
  getOpenAIReviewMode,
  selectOpenAIModel,
  type OpenAIModelSelection
} from "./model-routing.js";

interface ClassificationClient {
  setUsageContext(context: { repoFullName: string; feedbackId: string }): void;
  complete(
    systemPrompt: string,
    userMessage: string,
    options: { temperature: number; maxTokens: number }
  ): Promise<string>;
}

export interface OpenAIClassificationPass {
  route: OpenAIModelSelection;
  classifiedFeedback: ClassifiedFeedback;
}

export interface OpenAIRoutedClassification {
  classifiedFeedback: ClassifiedFeedback;
  passes: OpenAIClassificationPass[];
}

export async function classifyFeedbackWithOpenAIRouting(options: {
  feedbackItem: FeedbackItem;
  fileTree: string[];
  modelPreset: LLMModelPreset;
  createClient: (route: OpenAIModelSelection) => ClassificationClient;
}): Promise<OpenAIRoutedClassification> {
  const initialRoute: OpenAIModelSelection = {
    model: OPENAI_MODEL_IDS.luna,
    reasoningEffort: "high"
  };
  const passes: OpenAIClassificationPass[] = [];
  let classifiedFeedback = await new FeedbackClassifier(options.createClient(initialRoute))
    .classify(options.feedbackItem, options.fileTree);
  passes.push({ route: initialRoute, classifiedFeedback });

  if (classifiedFeedback.complexity !== "trivial") {
    const routedSelection = selectOpenAIModel(
      classifiedFeedback,
      options.modelPreset,
      getOpenAIReviewMode(classifiedFeedback)
    );
    classifiedFeedback = await new FeedbackClassifier(options.createClient(routedSelection))
      .classify(options.feedbackItem, options.fileTree);
    passes.push({ route: routedSelection, classifiedFeedback });
  }

  return { classifiedFeedback, passes };
}

import type { ClassifiedFeedback, ComplexityLevel, FeedbackItem, LLMModelPreset } from "@mosaic/core";
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
    options: { temperature: number; maxTokens: number; requestPhase?: string }
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

const complexityRanking: ComplexityLevel[] = ["trivial", "simple", "moderate", "complex"];

function higherComplexity(left: ComplexityLevel, right: ComplexityLevel): ComplexityLevel {
  return complexityRanking.indexOf(left) >= complexityRanking.indexOf(right) ? left : right;
}

export async function classifyFeedbackWithOpenAIRouting(options: {
  feedbackItem: FeedbackItem;
  fileTree: string[];
  modelPreset: LLMModelPreset;
  createClient: (route: OpenAIModelSelection) => ClassificationClient;
  onPass?: (pass: OpenAIClassificationPass) => void;
}): Promise<OpenAIRoutedClassification> {
  const initialRoute: OpenAIModelSelection = {
    model: OPENAI_MODEL_IDS.luna,
    reasoningEffort: "high"
  };
  const passes: OpenAIClassificationPass[] = [];
  const initialClassification = await new FeedbackClassifier(options.createClient(initialRoute))
    .classify(options.feedbackItem, options.fileTree);
  let classifiedFeedback = initialClassification;
  const initialPass = { route: initialRoute, classifiedFeedback: initialClassification };
  passes.push(initialPass);
  options.onPass?.(initialPass);

  if (classifiedFeedback.complexity !== "trivial") {
    const routedSelection = selectOpenAIModel(
      classifiedFeedback,
      options.modelPreset,
      getOpenAIReviewMode(classifiedFeedback)
    );
    const routedClassification = await new FeedbackClassifier(options.createClient(routedSelection))
      .classify(options.feedbackItem, options.fileTree);
    const routedPass = { route: routedSelection, classifiedFeedback: routedClassification };
    passes.push(routedPass);
    options.onPass?.(routedPass);
    classifiedFeedback = {
      ...routedClassification,
      complexity: higherComplexity(initialClassification.complexity, routedClassification.complexity)
    };
  }

  return { classifiedFeedback, passes };
}

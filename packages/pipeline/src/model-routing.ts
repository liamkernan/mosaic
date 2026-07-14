import type { ClassifiedFeedback, LLMModelPreset } from "@mosaic/core";
import { OPENAI_MODEL_IDS, type ANTHROPIC_MODEL_IDS, type OpenAIReasoningEffort } from "@mosaic/llm";

import { getModerateIssueMode } from "./staged-issues.js";

export type ModelTier = keyof typeof ANTHROPIC_MODEL_IDS;
export type ReviewMode = "moderate-safe" | "moderate-review-needed" | "complex-review-needed";

export interface OpenAIModelSelection {
  model: typeof OPENAI_MODEL_IDS[keyof typeof OPENAI_MODEL_IDS];
  reasoningEffort: OpenAIReasoningEffort;
}

export function getOpenAIReviewMode(classifiedFeedback: ClassifiedFeedback): ReviewMode | undefined {
  if (classifiedFeedback.complexity === "moderate") {
    return getModerateIssueMode(classifiedFeedback);
  }

  return classifiedFeedback.complexity === "complex" ? "complex-review-needed" : undefined;
}

const CLASSIFICATION_CONFIDENCE_THRESHOLD = 0.75;
const obviousFixPattern =
  /\b(typo|spelling|misspelling|copy|text|label|headline|heading|link|button text|cta|padding|margin|color|font|alignment|aligned|misaligned|css)\b/i;

function hasClearRelevantFiles(classifiedFeedback: ClassifiedFeedback): boolean {
  return classifiedFeedback.relevantFiles.length > 0;
}

function isNonObviousBugReport(classifiedFeedback: ClassifiedFeedback): boolean {
  if (classifiedFeedback.category !== "bug_report") {
    return false;
  }

  return !isObviousFix(classifiedFeedback);
}

function isObviousFix(classifiedFeedback: ClassifiedFeedback): boolean {
  const combinedText = `${classifiedFeedback.summary}\n${classifiedFeedback.rawContent}`;
  return obviousFixPattern.test(combinedText);
}

export function shouldEscalateClassification(classifiedFeedback: ClassifiedFeedback): boolean {
  if (classifiedFeedback.complexity === "complex") {
    return true;
  }

  if (classifiedFeedback.complexity === "moderate") {
    return true;
  }

  if (classifiedFeedback.confidence < CLASSIFICATION_CONFIDENCE_THRESHOLD) {
    return true;
  }

  if (!hasClearRelevantFiles(classifiedFeedback)) {
    return true;
  }

  return isNonObviousBugReport(classifiedFeedback);
}

export function selectGenerationModelTier(
  classifiedFeedback: ClassifiedFeedback,
  modelPreset: LLMModelPreset = "quality"
): ModelTier {
  if (classifiedFeedback.complexity === "complex") {
    return modelPreset === "quality" ? "opus" : "sonnet";
  }

  if (classifiedFeedback.complexity === "moderate") {
    return "sonnet";
  }

  if (classifiedFeedback.category === "bug_report" && !isObviousFix(classifiedFeedback)) {
    return "sonnet";
  }

  return "haiku";
}

export function selectPlanningModelTier(
  classifiedFeedback: ClassifiedFeedback,
  modelPreset: LLMModelPreset = "quality"
): ModelTier {
  return classifiedFeedback.complexity === "complex" && modelPreset === "quality" ? "opus" : "sonnet";
}

export function shouldUseAdvisorTool(
  classifiedFeedback: ClassifiedFeedback,
  modelPreset: LLMModelPreset = "quality"
): boolean {
  return modelPreset === "quality" && classifiedFeedback.complexity === "moderate";
}

export function selectOpenAIModel(
  classifiedFeedback: ClassifiedFeedback,
  _modelPreset: LLMModelPreset = "quality",
  reviewMode?: ReviewMode
): OpenAIModelSelection {
  if (classifiedFeedback.complexity === "trivial") {
    return { model: OPENAI_MODEL_IDS.luna, reasoningEffort: "high" };
  }

  if (classifiedFeedback.complexity === "complex") {
    return {
      model: OPENAI_MODEL_IDS.sol,
      reasoningEffort: "xhigh"
    };
  }

  if (reviewMode === "moderate-review-needed" || reviewMode === "complex-review-needed") {
    return { model: OPENAI_MODEL_IDS.sol, reasoningEffort: "high" };
  }

  if (classifiedFeedback.complexity === "moderate") {
    return { model: OPENAI_MODEL_IDS.terra, reasoningEffort: "xhigh" };
  }

  return {
    model: OPENAI_MODEL_IDS.terra,
    reasoningEffort: "high"
  };
}

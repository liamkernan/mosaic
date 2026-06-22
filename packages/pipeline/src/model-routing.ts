import type { ClassifiedFeedback, LLMModelPreset } from "@mosaic/core";

export type ModelTier = "haiku" | "sonnet";

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
    return "sonnet";
  }

  if (classifiedFeedback.complexity === "moderate") {
    return "sonnet";
  }

  if (classifiedFeedback.category === "bug_report" && !isObviousFix(classifiedFeedback)) {
    return "sonnet";
  }

  return "haiku";
}

export function selectPlanningModelTier(): ModelTier {
  return "sonnet";
}

export function shouldUseAdvisorTool(
  classifiedFeedback: ClassifiedFeedback,
  modelPreset: LLMModelPreset = "quality"
): boolean {
  return modelPreset === "quality" && classifiedFeedback.complexity === "complex";
}

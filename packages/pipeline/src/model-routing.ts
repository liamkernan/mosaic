import type { ClassifiedFeedback } from "@mosaic/core";

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

  const combinedText = `${classifiedFeedback.summary}\n${classifiedFeedback.rawContent}`;
  return !obviousFixPattern.test(combinedText);
}

export function shouldEscalateClassification(classifiedFeedback: ClassifiedFeedback): boolean {
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

export function selectGenerationModelTier(classifiedFeedback: ClassifiedFeedback): ModelTier {
  if (classifiedFeedback.complexity === "moderate") {
    return "sonnet";
  }

  if (classifiedFeedback.category === "ui_tweak" || classifiedFeedback.category === "bug_report") {
    return "sonnet";
  }

  return "haiku";
}

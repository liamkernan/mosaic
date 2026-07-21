import type {
  ClassifiedFeedback,
  ComplexityLevel,
  FeedbackCategory,
  FeedbackItem,
  FeedbackSource,
  RelevantFile
} from "../packages/core/src/types.js";
import { assessFeedbackContent, type AbuseAssessment } from "../packages/intake/src/abuse-protection.js";
import type { OpenAIReasoningEffort } from "../packages/llm/src/client.js";
import {
  classifyFeedbackWithOpenAIRouting,
  type OpenAIClassificationPass
} from "../packages/pipeline/src/classification-routing.js";
import {
  getOpenAIReviewMode,
  selectOpenAIModel,
  type OpenAIModelSelection
} from "../packages/pipeline/src/model-routing.js";

export type RoutingBenchmarkSplit = "development" | "holdout";
export type RoutingOutcomeKey =
  | "rejected-before-model"
  | "trivial"
  | "simple"
  | "moderate-safe"
  | "moderate-review-needed"
  | "complex-review-needed";
export type ExpectedReviewDecision = "none" | "not-required" | "required";

export interface RoutingBenchmarkInputCase {
  id: string;
  split: RoutingBenchmarkSplit;
  domain: string;
  boundaryPairId: string;
  repoFullName: string;
  source: FeedbackSource;
  senderIdentifier: string;
  rawContent: string;
  fileTree: string[];
  groundingFiles?: RelevantFile[];
}

export interface RoutingBenchmarkInputsFile {
  schemaVersion: number;
  benchmarkId: string;
  frozenAt: string;
  cases: RoutingBenchmarkInputCase[];
}

export interface RoutingBenchmarkExpectation {
  id: string;
  expectedSafetyOutcome: "accepted" | "rejected";
  expectedCategory?: FeedbackCategory;
  expectedComplexity?: ComplexityLevel;
  expectedReview: ExpectedReviewDecision;
  expectedRoute: {
    key: RoutingOutcomeKey;
    model: string | null;
    reasoningEffort: OpenAIReasoningEffort | null;
  };
  rationale: string;
  boundary: {
    contrastCaseId: string;
    factor: string;
  };
}

export interface RoutingBenchmarkExpectationsFile {
  schemaVersion: number;
  benchmarkId: string;
  frozenAt: string;
  expectations: RoutingBenchmarkExpectation[];
}

export interface UnscoredRoutingResult {
  id: string;
  split: RoutingBenchmarkSplit;
  domain: string;
  boundaryPairId: string;
  status: "completed" | "error";
  safetyAssessment: AbuseAssessment;
  classificationPasses: OpenAIClassificationPass[];
  finalClassification?: ClassifiedFeedback;
  finalReviewMode?: ReturnType<typeof getOpenAIReviewMode>;
  finalRoute?: OpenAIModelSelection;
  actualRouteKey: RoutingOutcomeKey | "error";
  error?: string;
}

export interface ScoredRoutingResult extends UnscoredRoutingResult {
  expected: RoutingBenchmarkExpectation;
  safetyCorrect: boolean;
  routeCorrect: boolean;
  categoryCorrect?: boolean;
  reviewCorrect?: boolean;
  passed: boolean;
  direction?: "under-routed" | "over-routed";
  suggestedFailureCause?:
    | "classifier/prompt failure"
    | "deterministic routing-policy failure"
    | "provider/model configuration failure";
}

export interface RoutingBenchmarkSummary {
  totalCases: number;
  passedCases: number;
  outcomeAccuracy: number;
  safeRoute: { correct: number; total: number; accuracy: number };
  review: { correct: number; total: number; accuracy: number };
  category: { correct: number; total: number; accuracy: number };
  safety: { correct: number; total: number; accuracy: number };
  underRoutingCount: number;
  overRoutingCount: number;
  otherFailureCount: number;
  confusionMatrix: {
    labels: Array<RoutingOutcomeKey | "error">;
    rows: Record<string, Record<string, number>>;
  };
}

interface ClassificationClient {
  setUsageContext(context: { repoFullName: string; feedbackId: string }): void;
  complete(
    systemPrompt: string,
    userMessage: string,
    options: { temperature: number; maxTokens: number }
  ): Promise<string>;
}

const safeRouteRanking: RoutingOutcomeKey[] = [
  "trivial",
  "simple",
  "moderate-safe",
  "moderate-review-needed",
  "complex-review-needed"
];

export const routingOutcomeLabels: Array<RoutingOutcomeKey | "error"> = [
  "rejected-before-model",
  ...safeRouteRanking,
  "error"
];

export function routeKeyForSelection(selection: OpenAIModelSelection): RoutingOutcomeKey | "error" {
  if (selection.model === "gpt-5.6-luna" && selection.reasoningEffort === "high") return "trivial";
  if (selection.model === "gpt-5.6-terra" && selection.reasoningEffort === "high") return "simple";
  if (selection.model === "gpt-5.6-terra" && selection.reasoningEffort === "xhigh") return "moderate-safe";
  if (selection.model === "gpt-5.6-sol" && selection.reasoningEffort === "high") return "moderate-review-needed";
  if (selection.model === "gpt-5.6-sol" && selection.reasoningEffort === "xhigh") return "complex-review-needed";
  return "error";
}

export function reviewDecisionForClassification(classifiedFeedback: ClassifiedFeedback): ExpectedReviewDecision {
  if (classifiedFeedback.complexity === "moderate") {
    return getOpenAIReviewMode(classifiedFeedback) === "moderate-safe" ? "not-required" : "required";
  }

  return classifiedFeedback.complexity === "complex" ? "required" : "none";
}

export async function runUnscoredRoutingCase(options: {
  inputCase: RoutingBenchmarkInputCase;
  createClient: (route: OpenAIModelSelection) => ClassificationClient;
  onClassificationPass?: (pass: OpenAIClassificationPass) => void;
}): Promise<UnscoredRoutingResult> {
  const { inputCase } = options;
  const safetyAssessment = assessFeedbackContent(inputCase.rawContent);
  const baseResult = {
    id: inputCase.id,
    split: inputCase.split,
    domain: inputCase.domain,
    boundaryPairId: inputCase.boundaryPairId,
    safetyAssessment
  };

  if (!safetyAssessment.accepted) {
    return {
      ...baseResult,
      status: "completed",
      classificationPasses: [],
      actualRouteKey: "rejected-before-model"
    };
  }

  const feedbackItem: FeedbackItem = {
    id: inputCase.id,
    repoFullName: inputCase.repoFullName,
    source: inputCase.source,
    senderIdentifier: inputCase.senderIdentifier,
    rawContent: inputCase.rawContent,
    receivedAt: new Date("2026-07-14T00:00:00.000Z"),
    metadata: {}
  };
  const routedClassification = await classifyFeedbackWithOpenAIRouting({
    feedbackItem,
    fileTree: inputCase.fileTree,
    modelPreset: "quality",
    createClient: options.createClient,
    ...(inputCase.groundingFiles
      ? {
          loadGroundingFiles: async (classification) => inputCase.groundingFiles?.filter((file) =>
            classification.relevantFiles.includes(file.path)
          ) ?? []
        }
      : {}),
    onPass: options.onClassificationPass
  });
  const finalClassification = routedClassification.classifiedFeedback;
  const finalReviewMode = getOpenAIReviewMode(finalClassification);
  const finalRoute = selectOpenAIModel(finalClassification, "quality", finalReviewMode);

  return {
    ...baseResult,
    status: "completed",
    classificationPasses: routedClassification.passes,
    finalClassification,
    finalReviewMode,
    finalRoute,
    actualRouteKey: routeKeyForSelection(finalRoute)
  };
}

function directionForRoutes(
  expected: RoutingOutcomeKey,
  actual: RoutingOutcomeKey | "error"
): "under-routed" | "over-routed" | undefined {
  const expectedRank = safeRouteRanking.indexOf(expected);
  const actualRank = safeRouteRanking.indexOf(actual as RoutingOutcomeKey);
  if (expectedRank < 0 || actualRank < 0 || expectedRank === actualRank) {
    return undefined;
  }
  return actualRank < expectedRank ? "under-routed" : "over-routed";
}

function suggestedCause(
  result: UnscoredRoutingResult,
  expected: RoutingBenchmarkExpectation
): ScoredRoutingResult["suggestedFailureCause"] {
  if (result.status === "error") {
    return "provider/model configuration failure";
  }
  if (result.safetyAssessment.accepted !== (expected.expectedSafetyOutcome === "accepted")) {
    return "deterministic routing-policy failure";
  }
  if (result.finalClassification?.complexity !== expected.expectedComplexity) {
    return "classifier/prompt failure";
  }
  if (expected.expectedCategory && result.finalClassification?.category !== expected.expectedCategory) {
    return "classifier/prompt failure";
  }
  return "deterministic routing-policy failure";
}

export function scoreRoutingResults(
  results: UnscoredRoutingResult[],
  expectations: RoutingBenchmarkExpectation[]
): { results: ScoredRoutingResult[]; summary: RoutingBenchmarkSummary } {
  const expectationsById = new Map(expectations.map((item) => [item.id, item]));
  const scoredResults = results.map<ScoredRoutingResult>((result) => {
    const expected = expectationsById.get(result.id);
    if (!expected) {
      throw new Error("Missing routing expectation for case: " + result.id);
    }
    const safetyCorrect = result.safetyAssessment.accepted === (expected.expectedSafetyOutcome === "accepted");
    const routeCorrect = result.actualRouteKey === expected.expectedRoute.key;
    const categoryCorrect = expected.expectedCategory
      ? result.finalClassification?.category === expected.expectedCategory
      : undefined;
    const reviewCorrect = expected.expectedComplexity === "moderate" && result.finalClassification
      ? reviewDecisionForClassification(result.finalClassification) === expected.expectedReview
      : undefined;
    const passed = safetyCorrect && routeCorrect && categoryCorrect !== false && reviewCorrect !== false;
    const direction = directionForRoutes(expected.expectedRoute.key, result.actualRouteKey);
    return {
      ...result,
      expected,
      safetyCorrect,
      routeCorrect,
      ...(categoryCorrect === undefined ? {} : { categoryCorrect }),
      ...(reviewCorrect === undefined ? {} : { reviewCorrect }),
      passed,
      ...(direction ? { direction } : {}),
      ...(passed ? {} : { suggestedFailureCause: suggestedCause(result, expected) })
    };
  });

  const safeResults = scoredResults.filter((result) => result.expected.expectedSafetyOutcome === "accepted");
  const reviewResults = scoredResults.filter((result) => result.expected.expectedComplexity === "moderate");
  const categoryResults = scoredResults.filter((result) => result.expected.expectedCategory !== undefined);
  const rows = Object.fromEntries(routingOutcomeLabels.map((expected) => [
    expected,
    Object.fromEntries(routingOutcomeLabels.map((actual) => [actual, 0]))
  ])) as Record<string, Record<string, number>>;
  for (const result of scoredResults) {
    rows[result.expected.expectedRoute.key][result.actualRouteKey] += 1;
  }

  const passedCases = scoredResults.filter((result) => result.passed).length;
  const safeCorrect = safeResults.filter((result) => result.routeCorrect).length;
  const reviewCorrect = reviewResults.filter((result) => result.reviewCorrect).length;
  const categoryCorrect = categoryResults.filter((result) => result.categoryCorrect).length;
  const safetyCorrect = scoredResults.filter((result) => result.safetyCorrect).length;
  const underRoutingCount = scoredResults.filter((result) => result.direction === "under-routed").length;
  const overRoutingCount = scoredResults.filter((result) => result.direction === "over-routed").length;

  return {
    results: scoredResults,
    summary: {
      totalCases: scoredResults.length,
      passedCases,
      outcomeAccuracy: scoredResults.length === 0 ? 0 : passedCases / scoredResults.length,
      safeRoute: {
        correct: safeCorrect,
        total: safeResults.length,
        accuracy: safeResults.length === 0 ? 0 : safeCorrect / safeResults.length
      },
      review: {
        correct: reviewCorrect,
        total: reviewResults.length,
        accuracy: reviewResults.length === 0 ? 0 : reviewCorrect / reviewResults.length
      },
      category: {
        correct: categoryCorrect,
        total: categoryResults.length,
        accuracy: categoryResults.length === 0 ? 0 : categoryCorrect / categoryResults.length
      },
      safety: {
        correct: safetyCorrect,
        total: scoredResults.length,
        accuracy: scoredResults.length === 0 ? 0 : safetyCorrect / scoredResults.length
      },
      underRoutingCount,
      overRoutingCount,
      otherFailureCount: scoredResults.filter((result) => !result.passed && !result.direction).length,
      confusionMatrix: { labels: routingOutcomeLabels, rows }
    }
  };
}

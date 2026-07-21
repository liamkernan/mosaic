import type {
  ClassifiedFeedback,
  ClassificationRoutingSignals,
  ComplexityLevel,
  FeedbackItem,
  LLMModelPreset,
  RelevantFile
} from "@mosaic/core";
import { OPENAI_MODEL_IDS } from "@mosaic/llm";

import { FeedbackClassifier } from "./classifier.js";
import type { ModelVisiblePlanPathPolicy } from "./implementation-plan-sanitizer.js";
import {
  getOpenAIReviewMode,
  selectOpenAIModel,
  type OpenAIModelSelection
} from "./model-routing.js";
import {
  resolveRoutingSignalComplexity,
  routingSignalsProveTrivial
} from "./routing-signals.js";

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

function reconcileRoutingSignals(
  initial: ClassificationRoutingSignals,
  routed: ClassificationRoutingSignals
): ClassificationRoutingSignals {
  return {
    // The stronger routed pass adjudicates ordinary implementation scope. A
    // cross-layer boundary remains sticky because downgrading it could bypass
    // required architecture and review safeguards.
    scope: initial.scope === "cross-layer" || routed.scope === "cross-layer"
      ? "cross-layer"
      : routed.scope,
    // Trivial needs positive agreement; behavior and hard-risk evidence are
    // retained if either pass observed them.
    literalCorrection: initial.literalCorrection === true && routed.literalCorrection === true,
    runtimeBehavior: initial.runtimeBehavior || routed.runtimeBehavior,
    persistentData: initial.persistentData || routed.persistentData,
    securitySensitive: initial.securitySensitive || routed.securitySensitive,
    requiresHumanReview: initial.requiresHumanReview || routed.requiresHumanReview
  };
}

export function reconcileClassifications(
  initial: ClassifiedFeedback,
  routed: ClassifiedFeedback
): ClassifiedFeedback {
  if (initial.routingSignals && routed.routingSignals) {
    const routingSignals = reconcileRoutingSignals(initial.routingSignals, routed.routingSignals);
    return {
      ...routed,
      complexity: resolveRoutingSignalComplexity(routed.complexity, routingSignals),
      routingSignals
    };
  }

  // Legacy or malformed signal omissions cannot justify a downward route.
  return {
    ...routed,
    complexity: higherComplexity(initial.complexity, routed.complexity),
    ...(routed.routingSignals
      ? { routingSignals: routed.routingSignals }
      : initial.routingSignals
        ? { routingSignals: initial.routingSignals }
        : {})
  };
}

export async function classifyFeedbackWithOpenAIRouting(options: {
  feedbackItem: FeedbackItem;
  fileTree: string[];
  modelPreset: LLMModelPreset;
  modelVisiblePlanPathPolicy?: ModelVisiblePlanPathPolicy;
  createClient: (route: OpenAIModelSelection) => ClassificationClient;
  loadGroundingFiles?: (classifiedFeedback: ClassifiedFeedback) => Promise<RelevantFile[]>;
  onPass?: (pass: OpenAIClassificationPass) => void;
}): Promise<OpenAIRoutedClassification> {
  const initialRoute: OpenAIModelSelection = {
    model: OPENAI_MODEL_IDS.luna,
    reasoningEffort: "high"
  };
  const passes: OpenAIClassificationPass[] = [];
  const initialClassification = await new FeedbackClassifier(options.createClient(initialRoute), {
    modelVisiblePlanPathPolicy: options.modelVisiblePlanPathPolicy
  })
    .classify(options.feedbackItem, options.fileTree);
  let classifiedFeedback = initialClassification;
  const initialPass = { route: initialRoute, classifiedFeedback: initialClassification };
  passes.push(initialPass);
  options.onPass?.(initialPass);

  const trivialIsProven = classifiedFeedback.complexity === "trivial" &&
    routingSignalsProveTrivial(classifiedFeedback.routingSignals) &&
    classifiedFeedback.relevantFiles.length > 0;
  if (!trivialIsProven) {
    const routedSelection = classifiedFeedback.complexity === "trivial"
      ? { model: OPENAI_MODEL_IDS.terra, reasoningEffort: "high" as const }
      : selectOpenAIModel(
          classifiedFeedback,
          options.modelPreset,
          getOpenAIReviewMode(classifiedFeedback)
        );
    const groundingFiles = await options.loadGroundingFiles?.(classifiedFeedback) ?? [];
    const routedClassification = await new FeedbackClassifier(options.createClient(routedSelection), {
      modelVisiblePlanPathPolicy: options.modelVisiblePlanPathPolicy
    })
      .classify(options.feedbackItem, options.fileTree, groundingFiles);
    const routedPass = { route: routedSelection, classifiedFeedback: routedClassification };
    passes.push(routedPass);
    options.onPass?.(routedPass);
    classifiedFeedback = reconcileClassifications(initialClassification, routedClassification);
  }

  return { classifiedFeedback, passes };
}

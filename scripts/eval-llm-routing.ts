import type { ClassifiedFeedback, LLMModelPreset, LLMProvider } from "../packages/core/src/types.js";
import {
  ANTHROPIC_ADVISOR_MAX_TOKENS,
  ANTHROPIC_ADVISOR_MODEL_ID,
  ANTHROPIC_MODEL_IDS,
  OPENAI_MODEL_IDS,
  type AdvisorToolOptions,
  type OpenAIReasoningEffort
} from "../packages/llm/src/client.js";
import {
  getOpenAIReviewMode,
  selectGenerationModelTier,
  selectOpenAIModel,
  selectPlanningModelTier,
  shouldUseAdvisorTool
} from "../packages/pipeline/src/model-routing.js";

export type EvalModelKey = keyof typeof ANTHROPIC_MODEL_IDS | keyof typeof OPENAI_MODEL_IDS;
export type EvalPreset = "direct" | LLMModelPreset;

export interface EvalClientRoute {
  model: string;
  reasoningEffort?: OpenAIReasoningEffort;
  advisorTool?: AdvisorToolOptions;
}

export interface EvalLlmRoutes {
  classification: EvalClientRoute;
  planning: EvalClientRoute;
  generation: EvalClientRoute;
}

export interface ExpectedOpenAIRoute {
  model: string;
  reasoningEffort: OpenAIReasoningEffort;
}

export function validateExpectedOpenAIRoute(
  routes: EvalLlmRoutes,
  expected: ExpectedOpenAIRoute
): string[] {
  return (["planning", "generation"] as const).flatMap((phase) => {
    const route = routes[phase];
    return route.model === expected.model && route.reasoningEffort === expected.reasoningEffort
      ? []
      : [
          `Automatically selected ${phase} route ${route.model}/${route.reasoningEffort ?? "default"}; ` +
          `expected ${expected.model}/${expected.reasoningEffort}`
        ];
  });
}

export function defaultEvalModelKey(provider: LLMProvider): EvalModelKey {
  return provider === "openai" ? "terra" : "sonnet";
}

export function isEvalModelKey(provider: LLMProvider, model: string): model is EvalModelKey {
  return provider === "openai" ? model in OPENAI_MODEL_IDS : model in ANTHROPIC_MODEL_IDS;
}

function directOpenAIReasoningEffort(model: keyof typeof OPENAI_MODEL_IDS): OpenAIReasoningEffort {
  if (model === "luna" || model === "terra") return "high";
  return "xhigh";
}

export function resolveEvalLlmRoutes(options: {
  provider: LLMProvider;
  model: EvalModelKey;
  preset: EvalPreset;
  feedback: ClassifiedFeedback;
}): EvalLlmRoutes {
  if (options.provider === "openai") {
    if (!(options.model in OPENAI_MODEL_IDS)) {
      throw new Error(`Unknown OpenAI model tier: ${options.model}`);
    }

    const directModel = options.model as keyof typeof OPENAI_MODEL_IDS;
    const directRoute: EvalClientRoute = {
      model: OPENAI_MODEL_IDS[directModel],
      reasoningEffort: directOpenAIReasoningEffort(directModel)
    };
    const reviewMode = getOpenAIReviewMode(options.feedback);
    const selection = options.preset === "direct"
      ? directRoute
      : selectOpenAIModel(options.feedback, options.preset, reviewMode);

    return {
      classification: { model: OPENAI_MODEL_IDS.luna, reasoningEffort: "high" },
      planning: selection,
      generation: selection
    };
  }

  if (!(options.model in ANTHROPIC_MODEL_IDS)) {
    throw new Error(`Unknown Anthropic model tier: ${options.model}`);
  }

  const directModel = options.model as keyof typeof ANTHROPIC_MODEL_IDS;
  const advisorTool = options.preset !== "direct" && shouldUseAdvisorTool(options.feedback, options.preset)
    ? {
        model: ANTHROPIC_ADVISOR_MODEL_ID,
        maxUses: 1,
        maxTokens: ANTHROPIC_ADVISOR_MAX_TOKENS
      }
    : undefined;

  return {
    classification: { model: ANTHROPIC_MODEL_IDS.haiku },
    planning: {
      model: options.preset === "direct"
        ? ANTHROPIC_MODEL_IDS[directModel]
        : ANTHROPIC_MODEL_IDS[selectPlanningModelTier(options.feedback, options.preset)],
      advisorTool
    },
    generation: {
      model: options.preset === "direct"
        ? ANTHROPIC_MODEL_IDS[directModel]
        : ANTHROPIC_MODEL_IDS[selectGenerationModelTier(options.feedback, options.preset)],
      advisorTool
    }
  };
}

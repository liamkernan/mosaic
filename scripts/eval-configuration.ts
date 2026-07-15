import {
  OPENAI_AUTOMATIC_TIMEOUT_FLOORS_MS
} from "../packages/llm/src/client.js";

export type EvalConfigurationSource =
  | "frozen-proof"
  | "process-environment"
  | "dotenv-default"
  | "automatic-tier-floor"
  | "unset";

export interface SourcedEvalConfigurationValue {
  value: number | null;
  source: EvalConfigurationSource;
}

export interface ResolvedEvalOpenAIConfiguration {
  frozenEvaluation: boolean;
  minOutputTokens: SourcedEvalConfigurationValue;
  minTimeoutMs: SourcedEvalConfigurationValue;
  automaticTierTimeoutFloors: Record<string, SourcedEvalConfigurationValue>;
}

interface EnvironmentNumericSetting {
  value: number | undefined;
  source: "process-environment" | "dotenv-default" | "unset";
}

interface ResolveNumericSettingOptions {
  frozenEvaluation: boolean;
  frozenProofValue?: number | null;
  environment: EnvironmentNumericSetting;
  automaticFallback: boolean;
}

function resolveNumericSetting(options: ResolveNumericSettingOptions): SourcedEvalConfigurationValue {
  if (options.frozenEvaluation && options.frozenProofValue !== undefined) {
    return { value: options.frozenProofValue, source: "frozen-proof" };
  }
  if (options.environment.source === "process-environment") {
    return { value: options.environment.value ?? null, source: "process-environment" };
  }
  if (!options.frozenEvaluation && options.environment.source === "dotenv-default") {
    return { value: options.environment.value ?? null, source: "dotenv-default" };
  }
  if (options.automaticFallback) {
    return { value: null, source: "automatic-tier-floor" };
  }
  return { value: null, source: "unset" };
}

export function resolveEvalOpenAIConfiguration(options: {
  frozenEvaluation: boolean;
  frozenProofMinOutputTokens?: number | null;
  frozenProofMinTimeoutMs?: number | null;
  environmentMinOutputTokens: EnvironmentNumericSetting;
  environmentMinTimeoutMs: EnvironmentNumericSetting;
}): ResolvedEvalOpenAIConfiguration {
  return {
    frozenEvaluation: options.frozenEvaluation,
    minOutputTokens: resolveNumericSetting({
      frozenEvaluation: options.frozenEvaluation,
      frozenProofValue: options.frozenProofMinOutputTokens,
      environment: options.environmentMinOutputTokens,
      automaticFallback: false
    }),
    minTimeoutMs: resolveNumericSetting({
      frozenEvaluation: options.frozenEvaluation,
      frozenProofValue: options.frozenProofMinTimeoutMs,
      environment: options.environmentMinTimeoutMs,
      automaticFallback: true
    }),
    automaticTierTimeoutFloors: Object.fromEntries(
      Object.entries(OPENAI_AUTOMATIC_TIMEOUT_FLOORS_MS).map(([route, value]) => [
        route,
        { value, source: "automatic-tier-floor" as const }
      ])
    )
  };
}

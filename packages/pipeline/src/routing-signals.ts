import type {
  ClassificationRoutingSignals,
  ComplexityLevel,
  RoutingScope
} from "@mosaic/core";

const complexityRanking: ComplexityLevel[] = ["trivial", "simple", "moderate", "complex"];
const routingScopes = new Set<RoutingScope>(["localized", "coordinated", "multi-component", "cross-layer"]);

export function isClassificationRoutingSignals(value: unknown): value is ClassificationRoutingSignals {
  if (!value || typeof value !== "object") {
    return false;
  }

  const signals = value as Partial<ClassificationRoutingSignals>;
  return routingScopes.has(signals.scope as RoutingScope) &&
    (signals.literalCorrection === undefined || typeof signals.literalCorrection === "boolean") &&
    typeof signals.runtimeBehavior === "boolean" &&
    typeof signals.persistentData === "boolean" &&
    typeof signals.securitySensitive === "boolean" &&
    typeof signals.requiresHumanReview === "boolean";
}

function minimumComplexity(signals: ClassificationRoutingSignals): ComplexityLevel {
  if (signals.scope === "cross-layer") {
    return "complex";
  }

  if (
    signals.scope === "multi-component" ||
    signals.persistentData ||
    signals.securitySensitive ||
    (signals.runtimeBehavior && signals.scope === "coordinated")
  ) {
    return "moderate";
  }

  if (signals.scope === "coordinated" || signals.runtimeBehavior) {
    return "simple";
  }

  if (signals.literalCorrection === false) {
    return "simple";
  }

  return "trivial";
}

export function applyRoutingSignalComplexityFloor(
  classifiedComplexity: ComplexityLevel,
  signals: ClassificationRoutingSignals | undefined
): ComplexityLevel {
  if (!signals) {
    return classifiedComplexity;
  }

  const floor = minimumComplexity(signals);
  return complexityRanking.indexOf(classifiedComplexity) >= complexityRanking.indexOf(floor)
    ? classifiedComplexity
    : floor;
}

export function routingSignalsRequireReview(signals: ClassificationRoutingSignals): boolean {
  return signals.requiresHumanReview ||
    signals.persistentData ||
    signals.securitySensitive ||
    signals.scope === "cross-layer";
}

import { describe, expect, it } from "vitest";

import {
  applyRoutingSignalComplexityFloor,
  routingSignalsRequireReview
} from "../packages/pipeline/src/routing-signals.js";

const localizedSignals = {
  scope: "localized",
  runtimeBehavior: false,
  persistentData: false,
  securitySensitive: false,
  requiresHumanReview: false
} as const;

describe("structured classification routing signals", () => {
  it.each([
    ["coordinated static labels", "trivial", { ...localizedSignals, scope: "coordinated" }, "simple"],
    ["multi-component UI state", "simple", { ...localizedSignals, scope: "multi-component", runtimeBehavior: true }, "moderate"],
    ["persistent causal behavior", "simple", { ...localizedSignals, persistentData: true, runtimeBehavior: true }, "moderate"],
    ["cross-layer runtime behavior", "moderate", { ...localizedSignals, scope: "cross-layer", runtimeBehavior: true }, "complex"]
  ] as const)("raises under-classified %s to %s", (_name, classified, signals, expected) => {
    expect(applyRoutingSignalComplexityFloor(classified, signals)).toBe(expected);
  });

  it("never lowers the model's classified complexity", () => {
    expect(applyRoutingSignalComplexityFloor("complex", localizedSignals)).toBe("complex");
    expect(applyRoutingSignalComplexityFloor("moderate", { ...localizedSignals, scope: "coordinated" }))
      .toBe("moderate");
  });

  it("requires review only for explicit, persistent, security, or cross-layer risk", () => {
    expect(routingSignalsRequireReview({
      ...localizedSignals,
      scope: "multi-component",
      runtimeBehavior: true
    })).toBe(false);
    expect(routingSignalsRequireReview({ ...localizedSignals, requiresHumanReview: true })).toBe(true);
    expect(routingSignalsRequireReview({ ...localizedSignals, persistentData: true })).toBe(true);
    expect(routingSignalsRequireReview({ ...localizedSignals, securitySensitive: true })).toBe(true);
    expect(routingSignalsRequireReview({ ...localizedSignals, scope: "cross-layer" })).toBe(true);
  });
});

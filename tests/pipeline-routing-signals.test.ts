import { describe, expect, it } from "vitest";

import {
  applyRoutingSignalComplexityFloor,
  resolveRoutingSignalComplexity,
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
    ["localized semantic or presentation change", "trivial", { ...localizedSignals, literalCorrection: false }, "simple"],
    ["multi-component UI state", "simple", { ...localizedSignals, scope: "multi-component", runtimeBehavior: true }, "moderate"],
    ["persistent causal behavior", "simple", { ...localizedSignals, persistentData: true, runtimeBehavior: true }, "moderate"],
    ["cross-layer runtime behavior", "moderate", { ...localizedSignals, scope: "cross-layer", runtimeBehavior: true }, "complex"]
  ] as const)("raises under-classified %s to %s", (_name, classified, signals, expected) => {
    expect(applyRoutingSignalComplexityFloor(classified, signals)).toBe(expected);
  });

  it("keeps the conservative floor API upward-only", () => {
    expect(applyRoutingSignalComplexityFloor("complex", localizedSignals)).toBe("complex");
    expect(applyRoutingSignalComplexityFloor("moderate", { ...localizedSignals, scope: "coordinated" }))
      .toBe("moderate");
  });

  it("requires explicit literal evidence for trivial routing", () => {
    expect(applyRoutingSignalComplexityFloor("trivial", { ...localizedSignals, literalCorrection: true }))
      .toBe("trivial");
    expect(applyRoutingSignalComplexityFloor("trivial", localizedSignals)).toBe("simple");
  });

  it("canonicalizes declared tiers from complete structured signals", () => {
    expect(resolveRoutingSignalComplexity("moderate", {
      ...localizedSignals,
      literalCorrection: false,
      runtimeBehavior: true
    })).toBe("simple");
    expect(resolveRoutingSignalComplexity("simple", {
      ...localizedSignals,
      literalCorrection: false,
      requiresHumanReview: true
    })).toBe("moderate");
    expect(resolveRoutingSignalComplexity("moderate", {
      ...localizedSignals,
      literalCorrection: false,
      scope: "cross-layer"
    })).toBe("complex");
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

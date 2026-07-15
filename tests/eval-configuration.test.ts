import { describe, expect, it } from "vitest";

import { resolveEvalOpenAIConfiguration } from "../scripts/eval-configuration.js";

const unsetEnvironment = { value: undefined, source: "unset" as const };

describe("frozen evaluation configuration precedence", () => {
  it("gives explicit frozen proof values precedence over the process environment", () => {
    const configuration = resolveEvalOpenAIConfiguration({
      frozenEvaluation: true,
      frozenProofMinOutputTokens: 49_152,
      frozenProofMinTimeoutMs: null,
      environmentMinOutputTokens: { value: 16_384, source: "process-environment" },
      environmentMinTimeoutMs: { value: 420_000, source: "process-environment" }
    });

    expect(configuration.minOutputTokens).toEqual({ value: 49_152, source: "frozen-proof" });
    expect(configuration.minTimeoutMs).toEqual({ value: null, source: "frozen-proof" });
  });

  it("does not let dotenv restore omitted frozen settings", () => {
    const configuration = resolveEvalOpenAIConfiguration({
      frozenEvaluation: true,
      environmentMinOutputTokens: { value: 49_152, source: "dotenv-default" },
      environmentMinTimeoutMs: { value: 420_000, source: "dotenv-default" }
    });

    expect(configuration.minOutputTokens).toEqual({ value: null, source: "unset" });
    expect(configuration.minTimeoutMs).toEqual({ value: null, source: "automatic-tier-floor" });
  });

  it("retains explicitly exported process settings when no frozen value replaces them", () => {
    const configuration = resolveEvalOpenAIConfiguration({
      frozenEvaluation: true,
      environmentMinOutputTokens: { value: 32_768, source: "process-environment" },
      environmentMinTimeoutMs: { value: 360_000, source: "process-environment" }
    });

    expect(configuration.minOutputTokens).toEqual({ value: 32_768, source: "process-environment" });
    expect(configuration.minTimeoutMs).toEqual({ value: 360_000, source: "process-environment" });
  });

  it("preserves dotenv defaults for ordinary local evaluations", () => {
    const configuration = resolveEvalOpenAIConfiguration({
      frozenEvaluation: false,
      environmentMinOutputTokens: { value: 16_384, source: "dotenv-default" },
      environmentMinTimeoutMs: { value: 300_000, source: "dotenv-default" }
    });

    expect(configuration.minOutputTokens).toEqual({ value: 16_384, source: "dotenv-default" });
    expect(configuration.minTimeoutMs).toEqual({ value: 300_000, source: "dotenv-default" });
  });

  it("records automatic tier-specific floors when no timeout override exists", () => {
    const configuration = resolveEvalOpenAIConfiguration({
      frozenEvaluation: false,
      environmentMinOutputTokens: unsetEnvironment,
      environmentMinTimeoutMs: unsetEnvironment
    });

    expect(configuration.minTimeoutMs).toEqual({ value: null, source: "automatic-tier-floor" });
    expect(configuration.automaticTierTimeoutFloors).toEqual({
      "gpt-5.6-sol/high": { value: 300_000, source: "automatic-tier-floor" },
      "gpt-5.6-sol/xhigh": { value: 480_000, source: "automatic-tier-floor" }
    });
  });
});

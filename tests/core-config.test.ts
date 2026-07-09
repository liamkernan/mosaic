import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expandHome, llmModelPresetOptions, llmProviderOptions, repoFullNamePattern, resetEnvForTests } from "../packages/core/src/config.js";
import { getEnv } from "../packages/core/src/index.js";

describe("core config helpers", () => {
  beforeEach(() => {
    resetEnvForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  it("expands home-prefixed paths", () => {
    expect(expandHome("~/mosaic")).toContain("mosaic");
  });

  it("validates owner/repo names", () => {
    expect(repoFullNamePattern.test("openai/mosaic")).toBe(true);
    expect(repoFullNamePattern.test("not a repo")).toBe(false);
  });

  it("exposes frontend-facing model preset toggle options", () => {
    expect(llmModelPresetOptions.map((option) => option.value)).toEqual(["quality", "balanced"]);
    expect(llmModelPresetOptions.map((option) => option.label)).toEqual(["Quality (Recommended)", "Balanced"]);
  });

  it("keeps Anthropic as the default provider and accepts an explicit OpenAI switch", () => {
    vi.stubEnv("MOSAIC_LLM_PROVIDER", undefined);
    resetEnvForTests();
    expect(getEnv().MOSAIC_LLM_PROVIDER).toBe("anthropic");
    expect(llmProviderOptions.map((option) => option.value)).toEqual(["anthropic", "openai"]);

    vi.stubEnv("MOSAIC_LLM_PROVIDER", "openai");
    resetEnvForTests();
    expect(getEnv().MOSAIC_LLM_PROVIDER).toBe("openai");

  });

  it("parses optional OpenAI evaluation overrides", () => {
    vi.stubEnv("MOSAIC_OPENAI_MIN_OUTPUT_TOKENS", "16384");
    vi.stubEnv("MOSAIC_OPENAI_MIN_TIMEOUT_MS", "300000");
    vi.stubEnv("MOSAIC_OPENAI_REASONING_EFFORT", "high");
    resetEnvForTests();

    expect(getEnv().MOSAIC_OPENAI_MIN_OUTPUT_TOKENS).toBe(16_384);
    expect(getEnv().MOSAIC_OPENAI_MIN_TIMEOUT_MS).toBe(300_000);
    expect(getEnv().MOSAIC_OPENAI_REASONING_EFFORT).toBe("high");

    vi.stubEnv("MOSAIC_OPENAI_MIN_OUTPUT_TOKENS", "");
    vi.stubEnv("MOSAIC_OPENAI_MIN_TIMEOUT_MS", "");
    vi.stubEnv("MOSAIC_OPENAI_REASONING_EFFORT", "");
    resetEnvForTests();

    expect(getEnv().MOSAIC_OPENAI_MIN_OUTPUT_TOKENS).toBeUndefined();
    expect(getEnv().MOSAIC_OPENAI_MIN_TIMEOUT_MS).toBeUndefined();
    expect(getEnv().MOSAIC_OPENAI_REASONING_EFFORT).toBeUndefined();
  });

  it("defaults the Mosaic trigger phrase when unset", () => {
    vi.stubEnv("MOSAIC_TRIGGER_PHRASE", "");
    resetEnvForTests();

    expect(getEnv().MOSAIC_TRIGGER_PHRASE).toBe("@mosaic");

  });

  it("defaults worker stalled-job settings for long-running pipeline jobs", () => {
    vi.stubEnv("WORKER_LOCK_DURATION_MS", undefined);
    vi.stubEnv("WORKER_STALLED_INTERVAL_MS", undefined);
    vi.stubEnv("WORKER_MAX_STALLED_COUNT", undefined);
    resetEnvForTests();

    expect(getEnv().WORKER_LOCK_DURATION_MS).toBe(600_000);
    expect(getEnv().WORKER_STALLED_INTERVAL_MS).toBe(120_000);
    expect(getEnv().WORKER_MAX_STALLED_COUNT).toBe(3);
  });

  it("defaults verification sandbox requirement to production only", () => {
    vi.stubEnv("VERIFICATION_REQUIRE_SANDBOX", undefined);

    vi.stubEnv("NODE_ENV", "production");
    resetEnvForTests();
    expect(getEnv().VERIFICATION_REQUIRE_SANDBOX).toBe(true);

    vi.stubEnv("NODE_ENV", "development");
    resetEnvForTests();
    expect(getEnv().VERIFICATION_REQUIRE_SANDBOX).toBe(false);
  });

  it.each([
    ["yes", true],
    ["off", false]
  ])("parses explicit verification sandbox boolean %s", (configuredValue, expected) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERIFICATION_REQUIRE_SANDBOX", configuredValue);
    resetEnvForTests();
    expect(getEnv().VERIFICATION_REQUIRE_SANDBOX).toBe(expected);
  });

  it("rejects invalid verification sandbox booleans", () => {
    vi.stubEnv("VERIFICATION_REQUIRE_SANDBOX", "definitely");
    resetEnvForTests();

    expect(() => getEnv()).toThrow();
  });
});

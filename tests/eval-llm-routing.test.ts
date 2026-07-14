import { describe, expect, it } from "vitest";

import type { ClassifiedFeedback } from "../packages/core/src/types.js";
import { resolveEvalLlmRoutes } from "../scripts/eval-llm-routing.js";

function feedback(complexity: ClassifiedFeedback["complexity"]): ClassifiedFeedback {
  return {
    id: "eval-case",
    repoFullName: "owner/repo",
    source: "web_form",
    senderIdentifier: "eval@example.com",
    receivedAt: new Date("2026-07-03T00:00:00Z"),
    category: "feature_request",
    complexity,
    summary: "Add a multi-file frontend interaction",
    rawContent: "Add a modal with content and keyboard behavior",
    relevantFiles: ["index.html", "script.js", "styles.css"],
    confidence: 0.8,
    metadata: {}
  };
}

describe("evaluation LLM routing", () => {
  it("uses GPT-5.6 Sol with high reasoning for moderate review-needed quality work", () => {
    expect(resolveEvalLlmRoutes({
      provider: "openai",
      model: "terra",
      preset: "quality",
      feedback: feedback("moderate")
    })).toEqual({
      classification: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      planning: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      generation: { model: "gpt-5.6-sol", reasoningEffort: "high" }
    });
  });

  it("uses GPT-5.6 Sol with extra-high reasoning for complex quality work", () => {
    const routes = resolveEvalLlmRoutes({
      provider: "openai",
      model: "terra",
      preset: "quality",
      feedback: feedback("complex")
    });

    expect(routes.planning).toEqual({ model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
    expect(routes.generation).toEqual({ model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  });

  it("keeps direct OpenAI evaluation on the explicitly selected tier", () => {
    const routes = resolveEvalLlmRoutes({
      provider: "openai",
      model: "luna",
      preset: "direct",
      feedback: feedback("complex")
    });

    expect(routes.planning).toEqual({ model: "gpt-5.6-luna", reasoningEffort: "high" });
    expect(routes.generation).toEqual({ model: "gpt-5.6-luna", reasoningEffort: "high" });
  });

  it("preserves Anthropic quality routing and advisor behavior", () => {
    const routes = resolveEvalLlmRoutes({
      provider: "anthropic",
      model: "sonnet",
      preset: "quality",
      feedback: feedback("moderate")
    });

    expect(routes.planning).toEqual({
      model: "claude-sonnet-5",
      advisorTool: { model: "claude-opus-4-8", maxUses: 1, maxTokens: 2048 }
    });
    expect(routes.generation).toEqual(routes.planning);
  });
});

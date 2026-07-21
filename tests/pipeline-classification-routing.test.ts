import { describe, expect, it, vi } from "vitest";

import type { ClassificationRoutingSignals, ComplexityLevel, FeedbackItem } from "../packages/core/src/types.js";
import {
  classifyFeedbackWithOpenAIRouting,
  reconcileClassifications
} from "../packages/pipeline/src/classification-routing.js";
import { decideFeedbackDisposition } from "../packages/pipeline/src/disposition.js";
import { containsProtectedModelVisiblePath } from "../packages/pipeline/src/implementation-plan-sanitizer.js";
import type { OpenAIModelSelection } from "../packages/pipeline/src/model-routing.js";
import { defaultRuntimeConfig } from "../packages/pipeline/src/repo-config.js";

const feedbackItem: FeedbackItem = {
  id: "01ROUTING",
  repoFullName: "owner/repo",
  source: "web_form",
  senderIdentifier: "routing@example.com",
  receivedAt: new Date("2026-07-14T00:00:00.000Z"),
  rawContent: "The profile label is wrong.",
  metadata: {}
};

function classification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const complexity = (overrides.complexity ?? "simple") as ComplexityLevel;
  const routingSignals: ClassificationRoutingSignals = complexity === "trivial"
    ? {
        scope: "localized",
        literalCorrection: true,
        runtimeBehavior: false,
        persistentData: false,
        securitySensitive: false,
        requiresHumanReview: false
      }
    : complexity === "simple"
      ? {
          scope: "localized",
          literalCorrection: false,
          runtimeBehavior: false,
          persistentData: false,
          securitySensitive: false,
          requiresHumanReview: false
        }
      : complexity === "moderate"
        ? {
            scope: "multi-component",
            literalCorrection: false,
            runtimeBehavior: true,
            persistentData: false,
            securitySensitive: false,
            requiresHumanReview: false
          }
        : {
            scope: "cross-layer",
            literalCorrection: false,
            runtimeBehavior: true,
            persistentData: true,
            securitySensitive: false,
            requiresHumanReview: true
          };

  return {
    category: "copy_change",
    complexity,
    summary: "Correct the profile label",
    relevantFiles: ["src/Profile.tsx"],
    confidence: 0.99,
    routingSignals,
    ...overrides
  };
}

function createFactory(responses: Record<string, unknown>[]): {
  routes: OpenAIModelSelection[];
  prompts: string[];
  createClient: (route: OpenAIModelSelection) => {
    setUsageContext: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
  };
} {
  const routes: OpenAIModelSelection[] = [];
  const prompts: string[] = [];
  const queuedResponses = [...responses];
  return {
    routes,
    prompts,
    createClient: (route) => {
      routes.push(route);
      const response = queuedResponses.shift();
      return {
        setUsageContext: vi.fn(),
        complete: vi.fn(async (systemPrompt: string) => {
          prompts.push(systemPrompt);
          return JSON.stringify(response);
        })
      };
    }
  };
}

describe("OpenAI production classification routing", () => {
  it("stops after Luna/high when the initial classification is trivial", async () => {
    const factory = createFactory([classification({ complexity: "trivial" })]);

    const result = await classifyFeedbackWithOpenAIRouting({
      feedbackItem,
      fileTree: ["src/Profile.tsx"],
      modelPreset: "quality",
      createClient: factory.createClient
    });

    expect(factory.routes).toEqual([{ model: "gpt-5.6-luna", reasoningEffort: "high" }]);
    expect(result.passes).toHaveLength(1);
    expect(result.classifiedFeedback.complexity).toBe("trivial");
  });

  it.each([
    [
      "simple",
      classification({ complexity: "simple" }),
      { model: "gpt-5.6-terra", reasoningEffort: "high" }
    ],
    [
      "moderate-safe",
      classification({ complexity: "moderate", rawContent: "Correct the profile label text." }),
      { model: "gpt-5.6-terra", reasoningEffort: "xhigh" }
    ],
    [
      "moderate-review-needed",
      classification({
        complexity: "moderate",
        category: "feature_request",
        routingSignals: {
          scope: "multi-component",
          literalCorrection: false,
          runtimeBehavior: true,
          persistentData: false,
          securitySensitive: false,
          requiresHumanReview: true
        }
      }),
      { model: "gpt-5.6-sol", reasoningEffort: "high" }
    ],
    [
      "complex-review-needed",
      classification({ complexity: "complex", category: "feature_request" }),
      { model: "gpt-5.6-sol", reasoningEffort: "xhigh" }
    ]
  ] as const)("reclassifies initial %s work on its selected production tier", async (_name, initial, expectedRoute) => {
    const factory = createFactory([initial, initial]);
    const routedFeedbackItem = {
      ...feedbackItem,
      rawContent: typeof initial.rawContent === "string" ? initial.rawContent : feedbackItem.rawContent
    };

    const result = await classifyFeedbackWithOpenAIRouting({
      feedbackItem: routedFeedbackItem,
      fileTree: ["src/Profile.tsx"],
      modelPreset: "quality",
      createClient: factory.createClient
    });

    expect(factory.routes).toEqual([
      { model: "gpt-5.6-luna", reasoningEffort: "high" },
      expectedRoute
    ]);
    expect(result.passes.map((pass) => pass.route)).toEqual(factory.routes);
    expect(result.classifiedFeedback.complexity).toBe(initial.complexity);
  });

  it("lets a stronger grounded pass correct soft scope for the Pulseboard local runtime bug", async () => {
    const factory = createFactory([
      classification({
        category: "bug_report",
        complexity: "moderate",
        summary: "Guard empty 204 and 205 response bodies before JSON parsing",
        relevantFiles: ["response-format.js", "app.js", "tests/test_response_format.py"],
        routingSignals: {
          scope: "multi-component",
          literalCorrection: false,
          runtimeBehavior: true,
          persistentData: false,
          securitySensitive: false,
          requiresHumanReview: false
        }
      }),
      classification({
        category: "bug_report",
        complexity: "simple",
        summary: "Guard empty response bodies in the response formatter",
        relevantFiles: ["response-format.js", "tests/test_response_format.py"],
        routingSignals: {
          scope: "localized",
          literalCorrection: false,
          runtimeBehavior: true,
          persistentData: false,
          securitySensitive: false,
          requiresHumanReview: false
        }
      })
    ]);

    const result = await classifyFeedbackWithOpenAIRouting({
      feedbackItem: {
        ...feedbackItem,
        rawContent: "Treat 204 and 205 responses and empty bodies as no-content before JSON parsing. Add regression coverage."
      },
      fileTree: ["response-format.js", "app.js", "tests/test_response_format.py"],
      modelPreset: "quality",
      createClient: factory.createClient
    });

    expect(result.passes.map((pass) => pass.classifiedFeedback.complexity)).toEqual(["moderate", "simple"]);
    expect(result.classifiedFeedback).toMatchObject({
      complexity: "simple",
      summary: "Guard empty response bodies in the response formatter",
      routingSignals: {
        scope: "localized",
        runtimeBehavior: true,
        persistentData: false,
        securitySensitive: false,
        requiresHumanReview: false
      }
    });
    expect(decideFeedbackDisposition(result.classifiedFeedback, {
      repoFullName: "owner/repo",
      ...defaultRuntimeConfig
    }).disposition).toBe("pr");
  });

  it("retains hard risk while allowing ordinary scope to be corrected", () => {
    const initial = {
      ...feedbackItem,
      category: "bug_report" as const,
      complexity: "moderate" as const,
      summary: "Change persisted session behavior",
      relevantFiles: ["src/session.ts"],
      confidence: 0.9,
      routingSignals: {
        scope: "multi-component" as const,
        literalCorrection: false,
        runtimeBehavior: true,
        persistentData: true,
        securitySensitive: true,
        requiresHumanReview: true
      }
    };
    const routed = {
      ...initial,
      complexity: "simple" as const,
      summary: "Change one local session helper",
      routingSignals: {
        scope: "localized" as const,
        literalCorrection: false,
        runtimeBehavior: true,
        persistentData: false,
        securitySensitive: false,
        requiresHumanReview: false
      }
    };

    const result = reconcileClassifications(initial, routed);

    expect(result).toMatchObject({
      complexity: "moderate",
      routingSignals: {
        scope: "localized",
        persistentData: true,
        securitySensitive: true,
        requiresHumanReview: true
      }
    });
    expect(decideFeedbackDisposition(result, {
      repoFullName: "owner/repo",
      ...defaultRuntimeConfig,
      maxComplexity: "moderate"
    })).toMatchObject({ disposition: "issue", issueMode: "moderate-review-needed" });
  });

  it.each([
    ["persistent data", { persistentData: true }],
    ["security sensitivity", { securitySensitive: true }],
    ["explicit review", { requiresHumanReview: true }]
  ] as const)("keeps initial %s evidence sticky across a soft routed downgrade", (_name, risk) => {
    const initial = {
      ...feedbackItem,
      category: "bug_report" as const,
      complexity: "moderate" as const,
      summary: "Change sensitive runtime behavior",
      relevantFiles: ["src/service.ts"],
      confidence: 0.9,
      routingSignals: {
        scope: "multi-component" as const,
        literalCorrection: false,
        runtimeBehavior: true,
        persistentData: false,
        securitySensitive: false,
        requiresHumanReview: false,
        ...risk
      }
    };
    const routed = {
      ...initial,
      complexity: "simple" as const,
      routingSignals: {
        scope: "localized" as const,
        literalCorrection: false,
        runtimeBehavior: true,
        persistentData: false,
        securitySensitive: false,
        requiresHumanReview: false
      }
    };

    const result = reconcileClassifications(initial, routed);

    expect(result.complexity).toBe("moderate");
    expect(result.routingSignals).toMatchObject(risk);
    expect(decideFeedbackDisposition(result, {
      repoFullName: "owner/repo",
      ...defaultRuntimeConfig,
      maxComplexity: "moderate"
    })).toMatchObject({ disposition: "issue", issueMode: "moderate-review-needed" });
  });

  it("accepts a stronger pass that raises ordinary scope to multi-component", () => {
    const initial = {
      ...feedbackItem,
      category: "bug_report" as const,
      complexity: "simple" as const,
      summary: "Update one local state owner",
      relevantFiles: ["src/view.ts"],
      confidence: 0.92,
      routingSignals: {
        scope: "localized" as const,
        literalCorrection: false,
        runtimeBehavior: true,
        persistentData: false,
        securitySensitive: false,
        requiresHumanReview: false
      }
    };
    const routed = {
      ...initial,
      complexity: "moderate" as const,
      summary: "Coordinate state across the list and detail components",
      relevantFiles: ["src/list.ts", "src/detail.ts"],
      routingSignals: { ...initial.routingSignals, scope: "multi-component" as const }
    };

    const result = reconcileClassifications(initial, routed);

    expect(result).toMatchObject({ complexity: "moderate", routingSignals: { scope: "multi-component" } });
    expect(decideFeedbackDisposition(result, {
      repoFullName: "owner/repo",
      ...defaultRuntimeConfig
    })).toMatchObject({ disposition: "issue", issueMode: "moderate-safe" });
  });

  it("does not permit a downward merge when either pass lacks structured signals", () => {
    const initial = {
      ...feedbackItem,
      category: "bug_report" as const,
      complexity: "moderate" as const,
      summary: "Uncertain multi-component behavior",
      relevantFiles: ["src/service.ts"],
      confidence: 0.8
    };
    const routed = {
      ...initial,
      complexity: "simple" as const,
      routingSignals: {
        scope: "localized" as const,
        literalCorrection: false,
        runtimeBehavior: true,
        persistentData: false,
        securitySensitive: false,
        requiresHumanReview: false
      }
    };

    expect(reconcileClassifications(initial, routed).complexity).toBe("moderate");
  });

  it("keeps cross-layer scope sticky across a routed downgrade", () => {
    const initial = {
      ...feedbackItem,
      category: "feature_request" as const,
      complexity: "complex" as const,
      summary: "Coordinate a workflow across runtime layers",
      relevantFiles: ["src/api.ts", "src/store.ts"],
      confidence: 0.9,
      routingSignals: {
        scope: "cross-layer" as const,
        literalCorrection: false,
        runtimeBehavior: true,
        persistentData: false,
        securitySensitive: false,
        requiresHumanReview: false
      }
    };
    const routed = {
      ...initial,
      complexity: "moderate" as const,
      routingSignals: {
        ...initial.routingSignals,
        scope: "multi-component" as const
      }
    };

    const result = reconcileClassifications(initial, routed);

    expect(result.complexity).toBe("complex");
    expect(result.routingSignals?.scope).toBe("cross-layer");
  });

  it("requires both passes to prove a correction is literal before routing trivial", () => {
    const initial = {
      ...feedbackItem,
      category: "copy_change" as const,
      complexity: "simple" as const,
      summary: "Correct one heading",
      relevantFiles: ["src/Profile.tsx"],
      confidence: 0.98,
      routingSignals: {
        scope: "localized" as const,
        literalCorrection: false,
        runtimeBehavior: false,
        persistentData: false,
        securitySensitive: false,
        requiresHumanReview: false
      }
    };
    const routed = {
      ...initial,
      complexity: "trivial" as const,
      routingSignals: { ...initial.routingSignals, literalCorrection: true }
    };

    expect(reconcileClassifications(initial, routed).complexity).toBe("simple");
    expect(reconcileClassifications(
      { ...initial, routingSignals: { ...initial.routingSignals, literalCorrection: true } },
      routed
    ).complexity).toBe("trivial");
  });

  it("loads preliminary candidate source for the stronger classification pass", async () => {
    const factory = createFactory([
      classification({
        category: "bug_report",
        complexity: "simple",
        relevantFiles: ["response-format.js"],
        routingSignals: {
          scope: "localized",
          literalCorrection: false,
          runtimeBehavior: true,
          persistentData: false,
          securitySensitive: false,
          requiresHumanReview: false
        }
      }),
      classification({
        category: "bug_report",
        complexity: "simple",
        relevantFiles: ["response-format.js"],
        routingSignals: {
          scope: "localized",
          literalCorrection: false,
          runtimeBehavior: true,
          persistentData: false,
          securitySensitive: false,
          requiresHumanReview: false
        }
      })
    ]);
    const loadGroundingFiles = vi.fn(async () => [{
      path: "response-format.js",
      content: "return JSON.parse(response.body);",
      reason: "preliminary candidate"
    }]);

    await classifyFeedbackWithOpenAIRouting({
      feedbackItem,
      fileTree: ["response-format.js"],
      modelPreset: "quality",
      createClient: factory.createClient,
      loadGroundingFiles
    });

    expect(loadGroundingFiles).toHaveBeenCalledOnce();
    expect(factory.prompts[0]).not.toContain("return JSON.parse(response.body)");
    expect(factory.prompts[1]).toContain("return JSON.parse(response.body)");
  });

  it("sanitizes canonical protected variants across both classification passes and their outputs", async () => {
    const policy = {
      protectedPaths: ["fixtures/hidden/expected.json"],
      protectedPathPrefixes: ["tests/baseline/", "tests/oracle/"],
      generatedTestPathPrefixes: ["tests/generated/"]
    };
    const allowedPaths = [
      "tests/generated/test_public.py",
      "src/Profile.tsx",
      "tests/oracle-helper/test_public.py",
      "tests/baseline_data/test_public.py",
      "fixtures/hidden/expected.schema.json"
    ];
    const factory = createFactory([
      classification({
        summary: "Compare tests/oracle/test_secret.py with Fixtures.Hidden.Expected.JSON.",
        relevantFiles: ["tests.baseline.test_snapshot", ...allowedPaths]
      }),
      classification({
        summary: "Keep TESTS\\BASELINE\\TEST_SNAPSHOT.PY unchanged.",
        relevantFiles: ["fixtures/hidden/expected.json", ...allowedPaths]
      })
    ]);

    const result = await classifyFeedbackWithOpenAIRouting({
      feedbackItem: {
        ...feedbackItem,
        rawContent: "Before editing, inspect tests.baseline.test_snapshot, TESTS\\ORACLE\\Test_Secret.py, and Fixtures.Hidden.Expected.JSON."
      },
      fileTree: [
        "tests/baseline/test_snapshot.py",
        "TESTS\\ORACLE\\Test_Secret.py",
        "fixtures.hidden.expected.json",
        ...allowedPaths
      ],
      modelPreset: "quality",
      modelVisiblePlanPathPolicy: policy,
      createClient: factory.createClient
    });

    expect(factory.prompts).toHaveLength(2);
    for (const prompt of factory.prompts) {
      expect(containsProtectedModelVisiblePath(prompt, policy)).toBe(false);
      expect(prompt).toContain("immutable verification tests");
      for (const allowedPath of allowedPaths) {
        expect(prompt).toContain(allowedPath);
      }
    }
    for (const pass of result.passes) {
      expect(containsProtectedModelVisiblePath(pass.classifiedFeedback.rawContent, policy)).toBe(false);
      expect(containsProtectedModelVisiblePath(pass.classifiedFeedback.summary, policy)).toBe(false);
      expect(pass.classifiedFeedback.relevantFiles).toEqual(allowedPaths.slice(0, 5));
    }
  });
});

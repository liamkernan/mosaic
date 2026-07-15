import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as OpenAIClientModule from "../packages/llm/src/openai.js";

const {
  queuedResponses,
  responsesCreateMock,
  createOpenAIClientMock,
  enforceRepoRateLimitMock,
  trackUsageMock
} = vi.hoisted(() => ({
  queuedResponses: [] as string[],
  responsesCreateMock: vi.fn(),
  createOpenAIClientMock: vi.fn(),
  enforceRepoRateLimitMock: vi.fn(async () => {}),
  trackUsageMock: vi.fn(async () => {})
}));

vi.mock("../packages/llm/src/openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof OpenAIClientModule>();
  return {
    ...actual,
    createOpenAIClient: createOpenAIClientMock.mockImplementation(() => ({
      responses: { create: responsesCreateMock }
    }))
  };
});

vi.mock("../packages/llm/src/rate-limiter.js", () => ({
  enforceRepoRateLimit: enforceRepoRateLimitMock
}));

vi.mock("../packages/llm/src/token-tracker.js", () => ({
  trackUsage: trackUsageMock
}));

import type { FeedbackItem, RelevantFile } from "../packages/core/src/types.js";
import {
  LLMClient,
  LLMRequestBoundaryError,
  type LLMRequestBoundaryAssertion,
  type LLMRequestAuthorization,
  type LLMUsageObservation,
  type OpenAIReasoningEffort
} from "../packages/llm/src/client.js";
import { classifyFeedbackWithOpenAIRouting } from "../packages/pipeline/src/classification-routing.js";
import { CodeGenerator } from "../packages/pipeline/src/code-generator.js";
import { ImplementationPlanner } from "../packages/pipeline/src/implementation-planner.js";
import {
  containsProtectedModelVisiblePath,
  type ModelVisiblePlanPathPolicy
} from "../packages/pipeline/src/implementation-plan-sanitizer.js";
import type { OpenAIModelSelection } from "../packages/pipeline/src/model-routing.js";

const policy: ModelVisiblePlanPathPolicy = {
  protectedPaths: ["fixtures/hidden/expected.json"],
  protectedPathPrefixes: ["tests/baseline/", "tests/oracle/"],
  generatedTestPathPrefixes: ["tests/generated/"]
};

function classification(summary: string, relevantFiles: string[]): string {
  return JSON.stringify({
    category: "feature_request",
    complexity: "simple",
    summary,
    relevantFiles,
    confidence: 0.99,
    routingSignals: {
      scope: "coordinated",
      literalCorrection: false,
      runtimeBehavior: true,
      persistentData: false,
      securitySensitive: false,
      requiresHumanReview: false
    }
  });
}

function changePayload(value: string): string {
  return `<changes>
  <change>
    <filePath>src/settings-form.tsx</filePath>
    <modifiedContent><![CDATA[export const settingsForm = "${value}";]]></modifiedContent>
    <explanation>Wire the visible settings workflow.</explanation>
  </change>
</changes>`;
}

describe("offline protected-request boundary", () => {
  beforeEach(() => {
    queuedResponses.length = 0;
    responsesCreateMock.mockReset();
    createOpenAIClientMock.mockClear();
    enforceRepoRateLimitMock.mockClear();
    trackUsageMock.mockClear();
    responsesCreateMock.mockImplementation(async () => {
      const outputText = queuedResponses.shift();
      if (outputText === undefined) {
        throw new Error("fake transport response queue exhausted");
      }
      return {
        output_text: outputText,
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          input_tokens_details: { cached_tokens: 2 }
        }
      };
    });
  });

  it("guards classification, planner retry, generation, and both repair phases before fake transport", async () => {
    queuedResponses.push(
      classification(
        "Implement settings without reading tests.oracle.test_settings.",
        ["src/settings-form.tsx", "tests/baseline/test_settings.py"]
      ),
      classification(
        "Implement settings without Fixtures\\Hidden\\Expected.json.",
        ["src/settings-form.tsx", "src/settings-service.ts", "TESTS\\ORACLE\\Test_Settings.py"]
      ),
      JSON.stringify({
        requiredFiles: [
          { path: "src/settings-form.tsx", reason: "add the settings form UI" },
          { path: "tests/oracle/test_settings.py", reason: "change the protected regression" }
        ],
        acceptanceCriteria: ["The form saves settings without tests.baseline.test_settings."],
        implementationChecklist: ["Keep TESTS\\ORACLE\\Test_Settings.py unchanged."],
        verificationChecklist: ["Compare Fixtures.Hidden.Expected.JSON."],
        verificationCommands: ["pnpm test -- tests/oracle/test_settings.py"]
      }),
      JSON.stringify({
        requiredFiles: [
          { path: "src/settings-form.tsx", reason: "wire the frontend settings form" },
          { path: "src/settings-service.ts", reason: "save preferences through the server service" }
        ],
        acceptanceCriteria: ["Submitting the form saves preferences through the service."],
        implementationChecklist: ["Connect the form submit action to the service."],
        verificationChecklist: ["Verify the public settings workflow."],
        verificationCommands: ["pnpm test"]
      }),
      changePayload("generated"),
      changePayload("validation-repaired"),
      changePayload("verification-repaired")
    );

    const assertRequest = vi.fn((request: LLMRequestBoundaryAssertion) => {
      if (containsProtectedModelVisiblePath(`${request.systemPrompt}\n${request.userMessage}`, policy)) {
        throw new LLMRequestBoundaryError("outbound evaluation request rejected");
      }
    });
    const authorizeRequest = vi.fn((_request: LLMRequestAuthorization) =>
      `reservation-${authorizeRequest.mock.calls.length}`
    );
    const observeUsage = vi.fn((_event: LLMUsageObservation) => {});
    const createClient = (
      model: string,
      reasoningEffort: OpenAIReasoningEffort | undefined
    ): LLMClient => new LLMClient({
      provider: "openai",
      mode: "platform",
      platformApiKey: "offline-fake-key",
      model,
      reasoningEffort,
      disableUsageTracking: true,
      assertRequest,
      authorizeRequest,
      observeUsage
    });
    const feedbackItem: FeedbackItem = {
      id: "01OFFLINEBOUNDARY",
      source: "web_form",
      rawContent: "Add a settings form that saves preferences through the server-side service; do not inspect tests.baseline.test_settings, TESTS\\ORACLE\\Test_Settings.py, or Fixtures.Hidden.Expected.JSON.",
      senderIdentifier: "offline@example.com",
      repoFullName: "owner/repo",
      receivedAt: new Date("2026-07-15T12:00:00.000Z"),
      metadata: {}
    };
    const fileTree = [
      "src/settings-form.tsx",
      "src/settings-service.ts",
      "tests/generated/settings.test.ts",
      "tests/baseline/test_settings.py",
      "TESTS\\ORACLE\\Test_Settings.py",
      "fixtures.hidden.expected.json"
    ];

    const routedClassification = await classifyFeedbackWithOpenAIRouting({
      feedbackItem,
      fileTree,
      modelPreset: "quality",
      modelVisiblePlanPathPolicy: policy,
      createClient: (route: OpenAIModelSelection) => createClient(route.model, route.reasoningEffort)
    });
    const relevantFiles: RelevantFile[] = [
      {
        path: "src/settings-form.tsx",
        content: "export const settingsForm = \"idle\";",
        reason: "frontend settings form"
      },
      {
        path: "src/settings-service.ts",
        content: "export const saveSettings = () => true;",
        reason: "backing settings service"
      }
    ];
    const modelVisibleFileTree = fileTree.slice(0, 3);
    const executionClient = createClient("gpt-5.6-terra", "high");
    const planner = new ImplementationPlanner(executionClient, {
      modelVisiblePlanPathPolicy: policy
    });
    const plan = await planner.plan(
      routedClassification.classifiedFeedback,
      relevantFiles,
      modelVisibleFileTree
    );
    const generator = new CodeGenerator(executionClient, {
      modelVisiblePlanPathPolicy: policy
    });
    const generated = await generator.generate(
      routedClassification.classifiedFeedback,
      relevantFiles,
      modelVisibleFileTree,
      plan
    );
    const validationRepaired = await generator.repairValidationFailure(
      routedClassification.classifiedFeedback,
      relevantFiles,
      modelVisibleFileTree,
      generated,
      ["Validation failed near Tests\\Oracle\\Test_Settings.py"],
      plan
    );
    const verificationRepaired = await generator.repairValidationFailure(
      routedClassification.classifiedFeedback,
      relevantFiles,
      modelVisibleFileTree,
      validationRepaired,
      ["Verification differs from Fixtures.Hidden.Expected.JSON"],
      plan,
      { requestPhase: "verification-repair" }
    );

    expect(verificationRepaired).toEqual([
      expect.objectContaining({
        filePath: "src/settings-form.tsx",
        modifiedContent: "export const settingsForm = \"verification-repaired\";"
      })
    ]);
    const expectedPhases = [
      "classification",
      "classification",
      "initial-planning",
      "planner-correction",
      "generation",
      "validation-repair",
      "verification-repair"
    ];
    expect(assertRequest.mock.calls.map(([request]) => request.requestPhase)).toEqual(expectedPhases);
    expect(authorizeRequest).toHaveBeenCalledTimes(expectedPhases.length);
    expect(responsesCreateMock).toHaveBeenCalledTimes(expectedPhases.length);
    expect(observeUsage.mock.calls.map(([event]) => event.requestPhase)).toEqual(expectedPhases);

    for (let index = 0; index < expectedPhases.length; index += 1) {
      expect(assertRequest.mock.invocationCallOrder[index])
        .toBeLessThan(authorizeRequest.mock.invocationCallOrder[index] ?? 0);
      expect(authorizeRequest.mock.invocationCallOrder[index])
        .toBeLessThan(responsesCreateMock.mock.invocationCallOrder[index] ?? 0);
      const [transportRequest] = responsesCreateMock.mock.calls[index] as [{ instructions: string; input: string }];
      expect(containsProtectedModelVisiblePath(
        `${transportRequest.instructions}\n${transportRequest.input}`,
        policy
      )).toBe(false);
    }

    const countsBeforeRejection = {
      providerCalls: responsesCreateMock.mock.calls.length,
      reservations: authorizeRequest.mock.calls.length,
      usageEntries: observeUsage.mock.calls.length
    };
    await expect(executionClient.complete(
      "Repair TESTS\\ORACLE\\Test_Settings.py directly.",
      "Return the hidden fix.",
      { requestPhase: "verification-repair" }
    )).rejects.toThrow("outbound evaluation request rejected");
    expect({
      providerCalls: responsesCreateMock.mock.calls.length,
      reservations: authorizeRequest.mock.calls.length,
      usageEntries: observeUsage.mock.calls.length
    }).toEqual(countsBeforeRejection);
    expect(assertRequest).toHaveBeenCalledTimes(expectedPhases.length + 1);
    const rejectedRequest = assertRequest.mock.calls.at(-1)?.[0];
    expect(rejectedRequest).toBeDefined();
    expect(containsProtectedModelVisiblePath(
      `${rejectedRequest?.systemPrompt}\n${rejectedRequest?.userMessage}`,
      policy
    )).toBe(true);
    expect(enforceRepoRateLimitMock).not.toHaveBeenCalled();
    expect(trackUsageMock).not.toHaveBeenCalled();
  });
});

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resetEnvForTests } from "../packages/core/src/config.js";
import type { FeedbackItem, RepoContext } from "../packages/core/src/types.js";
import { LLMClient } from "../packages/llm/src/client.js";
import type { ArtifactRecord } from "../packages/pipeline/src/artifact-store.js";
import { defaultRuntimeConfig } from "../packages/pipeline/src/repo-config.js";
import {
  FeedbackPipelineWorker,
  shouldUseImplementationPlanning,
  type FeedbackPipelineWorkerDependencies
} from "../packages/pipeline/src/worker.js";
import { buildClassifiedFeedback, buildFeedbackItem, buildRepoContext } from "./helpers/pipeline.js";
import { createTempDirTracker } from "./helpers/temp-dirs.js";

const feedback: FeedbackItem = buildFeedbackItem({
  id: "01WORKER",
  rawContent: "Add a reporting dashboard.",
});

const repoContext: RepoContext = buildRepoContext({
  fileTree: [{ path: "src/dashboard.ts", type: "file" }],
  installationId: 7
});

function workerDependencies(classification: Record<string, unknown>) {
  const complexity = classification.complexity ?? "simple";
  const routingSignals = complexity === "complex"
    ? {
        scope: "cross-layer",
        literalCorrection: false,
        runtimeBehavior: true,
        persistentData: true,
        securitySensitive: false,
        requiresHumanReview: true
      }
    : complexity === "moderate"
      ? {
          scope: "multi-component",
          literalCorrection: false,
          runtimeBehavior: true,
          persistentData: false,
          securitySensitive: false,
          requiresHumanReview: classification.category === "feature_request"
        }
      : {
          scope: "localized",
          literalCorrection: false,
          runtimeBehavior: false,
          persistentData: false,
          securitySensitive: false,
          requiresHumanReview: false
        };
  const complete = vi.fn(async (
    _systemPrompt: string,
    _userMessage?: string,
    _options?: { requestPhase?: string }
  ) => JSON.stringify({ routingSignals, ...classification }));
  const client = new LLMClient({
    mode: "platform",
    platformApiKey: "test-key",
    disableUsageTracking: true
  });
  vi.spyOn(client, "complete").mockImplementation(complete);

  const getArtifact = vi.fn(async (): Promise<ArtifactRecord | null> => null);
  const recordArtifact = vi.fn(async () => true);
  const createIssue = vi.fn(async () => 42);
  const quarantine = vi.fn(async () => undefined);
  const getContext = vi.fn(async () => repoContext);

  const dependencies = {
    artifactStore: { get: getArtifact, record: recordArtifact },
    repoIndexer: {
      getContext,
      fileTreeToPaths: vi.fn(() => ["src/dashboard.ts"]),
      findRelevantFiles: vi.fn(async () => []),
      findRepositoryReferenceFiles: vi.fn(async () => []),
      readFiles: vi.fn(async () => [])
    },
    issueCreator: { createIssue },
    prCreator: { createPR: vi.fn(async () => "https://github.com/owner/repo/pull/1") },
    quarantineStore: { quarantine },
    loadRepoRuntimeConfig: vi.fn(async () => ({
      repoFullName: "owner/repo",
      ...defaultRuntimeConfig
    })),
    createLlmClient: vi.fn(() => client)
  } satisfies FeedbackPipelineWorkerDependencies;

  return {
    dependencies,
    complete,
    getArtifact,
    recordArtifact,
    createIssue,
    quarantine,
    getContext
  };
}

describe("FeedbackPipelineWorker", () => {
  const tempDirs = createTempDirTracker();

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetEnvForTests();
    await tempDirs.cleanup();
  });

  it.each([
    ["a proven trivial direct correction", "trivial", undefined, false],
    ["a simple direct change", "simple", undefined, true],
    ["an opted-in moderate-safe promotion", "moderate", "moderate-safe", true],
    ["a staged correction with conservative metadata", "trivial", "moderate-review-needed", true]
  ] as const)("selects implementation planning for %s", (_name, complexity, issueMode, expected) => {
    expect(shouldUseImplementationPlanning(
      buildClassifiedFeedback({ complexity }),
      issueMode
    )).toBe(expected);
  });

  it("skips feedback that already has a recorded artifact", async () => {
    const setup = workerDependencies({});
    setup.getArtifact.mockResolvedValue({
      feedbackId: "01WORKER",
      repoFullName: "owner/repo",
      artifactType: "issue",
      artifactValue: "42",
      createdAt: "2026-07-01T12:00:00.000Z"
    });

    await expect(new FeedbackPipelineWorker(setup.dependencies).process(feedback)).resolves.toEqual({
      outcome: "succeeded",
      reason: "Skipped duplicate feedback; existing issue artifact is 42"
    });

    expect(setup.getContext).not.toHaveBeenCalled();
    expect(setup.complete).not.toHaveBeenCalled();
  });

  it("classifies moderate feedback, creates an issue, and records the artifact", async () => {
    const setup = workerDependencies({
      category: "feature_request",
      complexity: "moderate",
      summary: "Add reporting dashboard",
      relevantFiles: ["src/dashboard.ts"],
      confidence: 0.95
    });

    const result = await new FeedbackPipelineWorker(setup.dependencies).process(feedback);

    expect(setup.complete).toHaveBeenCalledTimes(2);
    expect(setup.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Add reporting dashboard" }),
      repoContext,
      expect.objectContaining({ issueMode: "moderate-review-needed" })
    );
    expect(setup.recordArtifact).toHaveBeenCalledWith(expect.objectContaining({
      feedbackId: "01WORKER",
      artifactType: "issue",
      artifactValue: "42"
    }));
    expect(result).toMatchObject({ outcome: "succeeded", reason: expect.stringContaining("Created issue #42") });
  });

  it("plans a direct simple behavioral PR before generation", async () => {
    const localPath = await tempDirs.create("mosaic-worker-planning-");
    await mkdir(join(localPath, "src"));
    const originalContent = [
      "def show_schedule(selected_day):",
      "    return selected_day or 'all'",
      ""
    ].join("\n");
    await writeFile(join(localPath, "src", "schedule.py"), originalContent, "utf8");

    const setup = workerDependencies({
      category: "bug_report",
      complexity: "simple",
      summary: "Reset the schedule when All days is selected",
      relevantFiles: ["src/schedule.py"],
      confidence: 0.95,
      routingSignals: {
        scope: "localized",
        literalCorrection: false,
        runtimeBehavior: true,
        persistentData: false,
        securitySensitive: false,
        requiresHumanReview: false
      }
    });
    const directRepoContext = buildRepoContext({
      localPath,
      fileTree: [
        {
          path: "src",
          type: "directory",
          children: [{ path: "src/schedule.py", type: "file", language: "python" }]
        }
      ],
      installationId: 7
    });
    setup.getContext.mockResolvedValue(directRepoContext);
    setup.dependencies.repoIndexer.fileTreeToPaths = vi.fn(() => ["src", "src/schedule.py"]);
    setup.dependencies.repoIndexer.findRelevantFiles = vi.fn(async () => [{
      path: "src/schedule.py",
      content: originalContent,
      reason: "Classifier selected the schedule behavior"
    }]);
    setup.complete.mockImplementation(async (_systemPrompt, _userMessage, options) => {
      if (options?.requestPhase === "initial-planning") {
        return JSON.stringify({
          requiredFiles: [{
            path: "src/schedule.py",
            reason: "Update the All days state transition"
          }],
          acceptanceCriteria: ["Selecting All days restores the complete schedule."],
          implementationChecklist: ["Update src/schedule.py to reset the selected-day filter."],
          verificationChecklist: [],
          verificationCommands: []
        });
      }

      if (options?.requestPhase === "generation") {
        return `<changes>
  <edit>
    <filePath>src/schedule.py</filePath>
    <search><![CDATA[    return selected_day or 'all']]></search>
    <replace><![CDATA[    return 'all' if selected_day == 'all' else selected_day or 'all']]></replace>
    <explanation>Reset the schedule when All days is selected.</explanation>
  </edit>
</changes>`;
      }

      return JSON.stringify({
        category: "bug_report",
        complexity: "simple",
        summary: "Reset the schedule when All days is selected",
        relevantFiles: ["src/schedule.py"],
        confidence: 0.95,
        routingSignals: {
          scope: "localized",
          literalCorrection: false,
          runtimeBehavior: true,
          persistentData: false,
          securitySensitive: false,
          requiresHumanReview: false
        }
      });
    });

    const result = await new FeedbackPipelineWorker(setup.dependencies).process({
      ...feedback,
      rawContent: "After Tuesday, choosing All days must restore the complete schedule."
    });

    const phases = setup.complete.mock.calls.map((call) => call[2]?.requestPhase);
    expect(phases).toContain("initial-planning");
    expect(phases.indexOf("initial-planning")).toBeLessThan(phases.indexOf("generation"));
    expect(setup.dependencies.prCreator.createPR).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [expect.objectContaining({ filePath: "src/schedule.py" })]
      }),
      directRepoContext,
      expect.anything(),
      expect.anything()
    );
    expect(result.reason).toContain("Created pull request");
  });

  it("persists quarantine decisions without creating an issue", async () => {
    const setup = workerDependencies({
      category: "other",
      complexity: "complex",
      summary: "Unsafe feedback",
      relevantFiles: [],
      confidence: 0.1
    });
    const dependencies: FeedbackPipelineWorkerDependencies = {
      ...setup.dependencies,
      decideFeedbackDisposition: () => ({ disposition: "quarantine", reason: "unsafe content" })
    };

    const result = await new FeedbackPipelineWorker(dependencies).process(feedback);

    expect(setup.quarantine).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Unsafe feedback" }),
      "unsafe content"
    );
    expect(setup.createIssue).not.toHaveBeenCalled();
    expect(setup.recordArtifact).toHaveBeenCalledWith(expect.objectContaining({
      artifactType: "quarantine",
      artifactValue: "unsafe content"
    }));
    expect(result).toEqual({
      outcome: "succeeded",
      reason: "Quarantined feedback because unsafe content"
    });
  });

  it("uses Azure OpenAI endpoint, key, and deployment override for OpenAI repos", async () => {
    vi.stubEnv("AZURE_OPENAI_API_KEY", "azure-openai-key");
    vi.stubEnv("OPENAI_API_KEY", "generic-openai-key");
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://mosaicopenai.openai.azure.com/");
    vi.stubEnv("MOSAIC_OPENAI_MODEL", "gpt-5.6-sol");
    vi.stubEnv("MOSAIC_OPENAI_REASONING_EFFORT", "high");
    vi.stubEnv("MOSAIC_OPENAI_MIN_OUTPUT_TOKENS", "16384");
    vi.stubEnv("MOSAIC_OPENAI_MIN_TIMEOUT_MS", "300000");
    resetEnvForTests();

    const setup = workerDependencies({
      category: "other",
      complexity: "simple",
      summary: "Needs unsupported work",
      relevantFiles: [],
      confidence: 0.95
    });
    setup.dependencies.loadRepoRuntimeConfig = vi.fn(async () => ({
      repoFullName: "owner/repo",
      ...defaultRuntimeConfig,
      llmProvider: "openai"
    }));

    await new FeedbackPipelineWorker(setup.dependencies).process(feedback);

    expect(setup.dependencies.createLlmClient).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai",
      platformApiKey: "azure-openai-key",
      openAIBaseURL: "https://mosaicopenai.openai.azure.com/openai/v1/",
      openAIMinOutputTokens: 16_384,
      openAIMinTimeoutMs: 300_000,
      model: "gpt-5.6-sol",
      reasoningEffort: "high"
    }));
  });

  it("classifies with the flattened nested file tree instead of top-level directories", async () => {
    const setup = workerDependencies({
      category: "other",
      complexity: "simple",
      summary: "Inspect the reported behavior",
      relevantFiles: ["tests/reported/trace.test.ts"],
      confidence: 0.95
    });
    setup.getContext.mockResolvedValue({
      ...repoContext,
      fileTree: [
        {
          path: "tests",
          type: "directory",
          children: [
            {
              path: "tests/reported",
              type: "directory",
              children: [{ path: "tests/reported/trace.test.ts", type: "file" }]
            }
          ]
        },
        { path: "response-format.ts", type: "file" }
      ]
    });
    setup.dependencies.repoIndexer.fileTreeToPaths = vi.fn(() => [
      "tests",
      "tests/reported",
      "tests/reported/trace.test.ts",
      "response-format.ts"
    ]);

    await new FeedbackPipelineWorker(setup.dependencies).process(feedback);

    const prompts = setup.complete.mock.calls.map((call) => String(call[0]));
    expect(prompts).toHaveLength(2);
    expect(prompts.every((prompt) => prompt.includes("tests/reported/trace.test.ts"))).toBe(true);
    expect(prompts.every((prompt) => !prompt.includes("\ntests\n"))).toBe(true);
  });
});

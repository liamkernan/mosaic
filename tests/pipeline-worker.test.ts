import { afterEach, describe, expect, it, vi } from "vitest";

import { resetEnvForTests } from "../packages/core/src/config.js";
import type { FeedbackItem, RepoContext } from "../packages/core/src/types.js";
import { LLMClient } from "../packages/llm/src/client.js";
import type { ArtifactRecord } from "../packages/pipeline/src/artifact-store.js";
import { defaultRuntimeConfig } from "../packages/pipeline/src/repo-config.js";
import {
  FeedbackPipelineWorker,
  type FeedbackPipelineWorkerDependencies
} from "../packages/pipeline/src/worker.js";
import { buildFeedbackItem, buildRepoContext } from "./helpers/pipeline.js";

const feedback: FeedbackItem = buildFeedbackItem({
  id: "01WORKER",
  rawContent: "Add a reporting dashboard.",
});

const repoContext: RepoContext = buildRepoContext({
  fileTree: [{ path: "src/dashboard.ts", type: "file" }],
  installationId: 7
});

function workerDependencies(classification: Record<string, unknown>) {
  const complete = vi.fn(async () => JSON.stringify(classification));
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
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvForTests();
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
});

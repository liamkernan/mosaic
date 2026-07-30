import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const {
  addLabelsMock,
  createCommentMock,
  getCollaboratorPermissionLevelMock,
  getIssueMock
} = vi.hoisted(() => ({
  addLabelsMock: vi.fn(async () => ({ data: {} })),
  createCommentMock: vi.fn(async () => ({ data: {} })),
  getCollaboratorPermissionLevelMock: vi.fn(async () => ({ data: { permission: "triage" } })),
  getIssueMock: vi.fn()
}));

vi.mock("@mosaic/github-app", () => ({
  getInstallationToken: vi.fn(),
  resolveInstallationId: vi.fn(),
  getOctokit: vi.fn(async () => ({
    rest: {
      issues: {
        addLabels: addLabelsMock,
        createComment: createCommentMock,
        get: getIssueMock
      },
      repos: {
        getCollaboratorPermissionLevel: getCollaboratorPermissionLevelMock
      }
    }
  }))
}));

import { resetEnvForTests } from "../packages/core/src/config.js";
import { LLMError } from "../packages/core/src/errors.js";
import type { ClassifiedFeedback, FeedbackItem, RepoContext } from "../packages/core/src/types.js";
import { LLMClient } from "../packages/llm/src/client.js";
import type { ArtifactRecord } from "../packages/pipeline/src/artifact-store.js";
import { defaultRuntimeConfig } from "../packages/pipeline/src/repo-config.js";
import {
  buildIssueSpecDigest,
  buildStagedIssueMetadata,
  buildStagedIssueMetadataComment
} from "../packages/pipeline/src/staged-issues.js";
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
    addLabelsMock.mockClear();
    createCommentMock.mockClear();
    getCollaboratorPermissionLevelMock.mockClear();
    getIssueMock.mockReset();
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

  it("reclassifies a materially edited staged issue and uses the fresh multi-file review route", async () => {
    vi.stubEnv("MOSAIC_STAGED_ISSUE_SECRET", "test-staged-secret");
    resetEnvForTests();

    const localPath = await tempDirs.create("mosaic-worker-staged-promotion-");
    await mkdir(join(localPath, "src"));
    const fileContents = new Map([
      ["src/label.py", "LABEL = 'old'\n"],
      ["src/service.py", "SERVICE_STATE = 'old'\n"],
      ["src/registry.py", "REGISTRY_STATE = 'old'\n"]
    ]);
    await Promise.all([...fileContents].map(([path, content]) =>
      writeFile(join(localPath, path), content, "utf8")
    ));

    const originalTitle = "[Feedback] Fix the settings label";
    const originalBody = "## User Feedback\n\nOnly adjust the settings label.";
    const issueSpecDigest = buildIssueSpecDigest(originalTitle, originalBody);
    const stagedMetadata = {
      ...buildStagedIssueMetadata(buildClassifiedFeedback({
        id: "01ORIGINAL",
        source: "web_form",
        senderIdentifier: "reporter@example.com",
        rawContent: "Only adjust the settings label.",
        category: "copy_change",
        complexity: "moderate",
        summary: "Fix the settings label",
        relevantFiles: ["src/label.py"],
        confidence: 0.99,
        routingSignals: {
          scope: "localized",
          literalCorrection: false,
          runtimeBehavior: false,
          persistentData: false,
          securitySensitive: false,
          requiresHumanReview: false
        }
      }), "moderate-safe"),
      issueSpecDigest
    };
    const editedBody = `${originalBody}

## Edited implementation scope

Coordinate the service and registry state updates; both files must change.

${buildStagedIssueMetadataComment(stagedMetadata)}`;
    getIssueMock.mockResolvedValue({
      data: {
        title: originalTitle,
        body: editedBody,
        labels: ["mosaic:staged", "mosaic:moderate-safe"],
        user: { login: "alice" }
      }
    });

    const freshClassification = {
      category: "bug_report",
      complexity: "moderate",
      summary: "Coordinate service and registry state",
      relevantFiles: ["src/service.py", "src/registry.py"],
      confidence: 0.96,
      routingSignals: {
        scope: "multi-component",
        literalCorrection: false,
        runtimeBehavior: true,
        persistentData: false,
        securitySensitive: false,
        requiresHumanReview: true
      }
    };
    const setup = workerDependencies(freshClassification);
    const promotionRepoContext = buildRepoContext({
      localPath,
      installationId: 7,
      fileTree: [...fileContents.keys()].map((path) => ({
        path,
        type: "file" as const,
        language: "python"
      }))
    });
    setup.getContext.mockResolvedValue(promotionRepoContext);
    setup.dependencies.repoIndexer.fileTreeToPaths = vi.fn(() => [...fileContents.keys()]);
    setup.dependencies.repoIndexer.findRelevantFiles = vi.fn(async (
      _context: RepoContext,
      classified: ClassifiedFeedback
    ) =>
      classified.relevantFiles.map((path) => ({
        path,
        content: fileContents.get(path) ?? "",
        reason: "Fresh classifier evidence"
      }))
    );
    setup.dependencies.repoIndexer.readFiles = vi.fn(async (
      _context: RepoContext,
      requestedFiles: Array<{ path: string; reason: string }>
    ) =>
      requestedFiles.map(({ path, reason }) => ({
        path,
        content: fileContents.get(path) ?? "",
        reason
      }))
    );
    setup.complete.mockImplementation(async (_systemPrompt, _userMessage, options) => {
      if (options?.requestPhase === "classification") {
        return JSON.stringify(freshClassification);
      }

      if (options?.requestPhase === "initial-planning") {
        return JSON.stringify({
          requiredFiles: [
            { path: "src/service.py", reason: "Update the service state" },
            { path: "src/registry.py", reason: "Update the registry state" }
          ],
          acceptanceCriteria: ["The service and registry expose the coordinated updated state."],
          implementationChecklist: [
            "Update src/service.py.",
            "Update src/registry.py."
          ],
          verificationChecklist: [],
          verificationCommands: []
        });
      }

      if (options?.requestPhase === "generation") {
        return `<changes>
  <edit>
    <filePath>src/service.py</filePath>
    <search><![CDATA[SERVICE_STATE = 'old']]></search>
    <replace><![CDATA[SERVICE_STATE = 'coordinated']]></replace>
    <explanation>Coordinate the service state.</explanation>
  </edit>
  <edit>
    <filePath>src/registry.py</filePath>
    <search><![CDATA[REGISTRY_STATE = 'old']]></search>
    <replace><![CDATA[REGISTRY_STATE = 'coordinated']]></replace>
    <explanation>Coordinate the registry state.</explanation>
  </edit>
</changes>`;
      }

      throw new Error(`Unexpected LLM phase: ${options?.requestPhase ?? "unknown"}`);
    });

    const result = await new FeedbackPipelineWorker(setup.dependencies).process(buildFeedbackItem({
      id: "01PROMOTION",
      source: "github_comment",
      rawContent: "@mosaic fix this",
      senderIdentifier: "alice",
      metadata: { issueNumber: 73 }
    }));

    const phases = setup.complete.mock.calls.map((call) => call[2]?.requestPhase);
    expect(phases.slice(0, 2)).toEqual(["classification", "classification"]);
    expect(phases.indexOf("classification")).toBeLessThan(phases.indexOf("initial-planning"));
    expect(setup.dependencies.prCreator.createPR).toHaveBeenCalledWith(
      expect.objectContaining({
        feedbackItem: expect.objectContaining({
          summary: freshClassification.summary,
          relevantFiles: ["src/service.py", "src/registry.py"],
          rawContent: expect.stringContaining("both files must change")
        }),
        changes: expect.arrayContaining([
          expect.objectContaining({ filePath: "src/service.py" }),
          expect.objectContaining({ filePath: "src/registry.py" })
        ])
      }),
      promotionRepoContext,
      expect.anything(),
      expect.objectContaining({
        draft: true,
        linkedIssueNumber: 73
      })
    );
    expect(addLabelsMock).toHaveBeenCalled();
    expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 73,
      body: expect.stringContaining("draft PR")
    }));
    expect(result.reason).toContain("Created pull request");
  });

  it("trusts signed routing for formatting-only staged issue edits", async () => {
    vi.stubEnv("MOSAIC_STAGED_ISSUE_SECRET", "test-staged-secret");
    resetEnvForTests();

    const title = "[Feedback] Review incomplete settings feedback";
    const visibleBody = "## User Feedback\n\nThe original source was incomplete.";
    const metadata = buildStagedIssueMetadata(buildClassifiedFeedback({
      id: "01ORIGINAL",
      rawContent: "x".repeat(5_000),
      contentTruncation: {
        originalLength: 5_041,
        retainedLength: 5_000
      },
      category: "ui_tweak",
      complexity: "moderate",
      summary: "Review incomplete settings feedback",
      relevantFiles: ["src/settings.tsx"],
      confidence: 0.95
    }), "moderate-review-needed", {
      title,
      body: visibleBody
    });
    const formattingOnlyBody = `\r\n${visibleBody.replace(/\n/g, "  \r\n")}\t\r\n${buildStagedIssueMetadataComment(metadata)}\r\n`;
    getIssueMock.mockResolvedValue({
      data: {
        title,
        body: formattingOnlyBody,
        labels: ["mosaic:staged", "mosaic:moderate-review-needed"],
        user: { login: "alice" }
      }
    });
    const setup = workerDependencies({});

    const result = await new FeedbackPipelineWorker(setup.dependencies).process(buildFeedbackItem({
      id: "01FORMATTING",
      source: "github_comment",
      rawContent: "@mosaic fix this",
      senderIdentifier: "alice",
      metadata: { issueNumber: 74 }
    }));

    expect(setup.complete).not.toHaveBeenCalled();
    expect(setup.dependencies.prCreator.createPR).not.toHaveBeenCalled();
    expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 74,
      body: expect.stringContaining("incomplete request")
    }));
    expect(result.reason).toContain("Kept staged issue #74");
  });

  it("keeps signed intake truncation sticky across material issue reclassification", async () => {
    vi.stubEnv("MOSAIC_STAGED_ISSUE_SECRET", "test-staged-secret");
    resetEnvForTests();

    const title = "[Feedback] Review incomplete dashboard feedback";
    const originalBody = "## User Feedback\n\nThe original source was incomplete.";
    const metadata = buildStagedIssueMetadata(buildClassifiedFeedback({
      id: "01TRUNCATED",
      rawContent: "x".repeat(5_000),
      contentTruncation: {
        originalLength: 5_041,
        retainedLength: 5_000
      },
      category: "ui_tweak",
      complexity: "moderate",
      summary: "Review incomplete dashboard feedback",
      relevantFiles: ["src/dashboard.ts"],
      confidence: 0.95
    }), "moderate-review-needed", {
      title,
      body: originalBody
    });
    getIssueMock.mockResolvedValue({
      data: {
        title,
        body: `${originalBody}\n\nAlso change the dashboard runtime behavior.\n${buildStagedIssueMetadataComment(metadata)}`,
        labels: ["mosaic:staged", "mosaic:moderate-review-needed"],
        user: { login: "alice" }
      }
    });
    const freshClassification = {
      category: "bug_report",
      complexity: "simple",
      summary: "Change dashboard runtime behavior",
      relevantFiles: ["src/dashboard.ts"],
      confidence: 0.97,
      routingSignals: {
        scope: "localized",
        literalCorrection: false,
        runtimeBehavior: true,
        persistentData: false,
        securitySensitive: false,
        requiresHumanReview: false
      }
    };
    const setup = workerDependencies(freshClassification);

    const result = await new FeedbackPipelineWorker(setup.dependencies).process(buildFeedbackItem({
      id: "01TRUNCATED-PROMOTION",
      source: "github_comment",
      rawContent: "@mosaic fix this",
      senderIdentifier: "alice",
      metadata: { issueNumber: 77 }
    }));

    const phases = setup.complete.mock.calls.map((call) => call[2]?.requestPhase);
    expect(phases.length).toBeGreaterThan(0);
    expect(phases.every((phase) => phase === "classification")).toBe(true);
    expect(setup.dependencies.prCreator.createPR).not.toHaveBeenCalled();
    expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 77,
      body: expect.stringContaining("incomplete request")
    }));
    expect(result.reason).toContain("Kept staged issue #77");
  });

  it("reclassifies legacy staged issues and fails closed on malformed fresh output", async () => {
    vi.stubEnv("MOSAIC_STAGED_ISSUE_SECRET", "test-staged-secret");
    resetEnvForTests();

    const legacyMetadata = buildStagedIssueMetadata(buildClassifiedFeedback({
      id: "01LEGACY",
      rawContent: "Fix the settings label.",
      category: "copy_change",
      complexity: "moderate",
      summary: "Fix the settings label",
      relevantFiles: ["src/settings.tsx"],
      confidence: 0.99
    }), "moderate-safe");
    getIssueMock.mockResolvedValue({
      data: {
        title: "[Feedback] Fix the settings label",
        body: `Legacy staged issue body.\n${buildStagedIssueMetadataComment(legacyMetadata)}`,
        labels: ["mosaic:staged", "mosaic:moderate-safe"],
        user: { login: "alice" }
      }
    });
    const setup = workerDependencies({});
    setup.complete.mockResolvedValue("{malformed-classification");

    const result = await new FeedbackPipelineWorker(setup.dependencies).process(buildFeedbackItem({
      id: "01LEGACY-PROMOTION",
      source: "github_comment",
      rawContent: "@mosaic fix this",
      senderIdentifier: "alice",
      metadata: { issueNumber: 75 }
    }));

    const phases = setup.complete.mock.calls.map((call) => call[2]?.requestPhase);
    expect(phases.length).toBeGreaterThanOrEqual(2);
    expect(phases.every((phase) => phase === "classification")).toBe(true);
    expect(setup.dependencies.prCreator.createPR).not.toHaveBeenCalled();
    expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 75,
      body: expect.stringContaining("not grounded strongly enough")
    }));
    expect(result.reason).toContain("Kept staged issue #75");
  });

  it("authorizes staged promotion before spending reclassification budget", async () => {
    vi.stubEnv("MOSAIC_STAGED_ISSUE_SECRET", "test-staged-secret");
    resetEnvForTests();

    const metadata = buildStagedIssueMetadata(buildClassifiedFeedback({
      id: "01ORIGINAL",
      complexity: "moderate",
      relevantFiles: ["src/settings.tsx"]
    }), "moderate-safe");
    getIssueMock.mockResolvedValue({
      data: {
        title: "[Feedback] Edited settings work",
        body: `Materially edited legacy issue.\n${buildStagedIssueMetadataComment(metadata)}`,
        labels: ["mosaic:staged", "mosaic:moderate-safe"],
        user: { login: "alice" }
      }
    });
    getCollaboratorPermissionLevelMock.mockResolvedValueOnce({
      data: { permission: "read" }
    });
    const setup = workerDependencies({});

    const result = await new FeedbackPipelineWorker(setup.dependencies).process(buildFeedbackItem({
      id: "01UNAUTHORIZED",
      source: "github_comment",
      rawContent: "@mosaic fix this",
      senderIdentifier: "mallory",
      metadata: { issueNumber: 76 }
    }));

    expect(setup.complete).not.toHaveBeenCalled();
    expect(setup.dependencies.prCreator.createPR).not.toHaveBeenCalled();
    expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 76,
      body: expect.stringContaining("issue author or a repo collaborator")
    }));
    expect(result.reason).toContain("unauthorized promotion");
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

  it.each([
    ["malformed planner JSON", "{bad-json}"],
    ["a repeatedly incomplete plan", JSON.stringify({
      requiredFiles: [],
      acceptanceCriteria: [],
      implementationChecklist: [],
      verificationChecklist: [],
      verificationCommands: []
    })]
  ])("falls back to a review issue when planning returns %s", async (_caseName, plannerResponse) => {
    const classification = {
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
    };
    const setup = workerDependencies(classification);
    setup.dependencies.repoIndexer.fileTreeToPaths = vi.fn(() => ["src/schedule.py"]);
    setup.dependencies.repoIndexer.findRelevantFiles = vi.fn(async () => [{
      path: "src/schedule.py",
      content: "def show_schedule(selected_day):\n    return selected_day or 'all'\n",
      reason: "Classifier selected the schedule behavior"
    }]);
    setup.complete.mockImplementation(async (_systemPrompt, _userMessage, options) => {
      if (options?.requestPhase === "initial-planning" || options?.requestPhase === "planner-correction") {
        return plannerResponse;
      }

      return JSON.stringify(classification);
    });

    const result = await new FeedbackPipelineWorker(setup.dependencies).process(feedback);

    expect(setup.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ summary: classification.summary }),
      repoContext,
      expect.objectContaining({ reason: expect.stringContaining("Implementation planning failed") })
    );
    expect(setup.dependencies.prCreator.createPR).not.toHaveBeenCalled();
    expect(setup.recordArtifact).toHaveBeenCalledWith(expect.objectContaining({
      artifactType: "issue",
      artifactValue: "42"
    }));
    expect(result).toMatchObject({
      outcome: "succeeded",
      reason: expect.stringContaining("Created issue #42 because Implementation planning failed")
    });
  });

  it("leaves transient planner overloads for the worker retry path", async () => {
    const classification = {
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
    };
    const setup = workerDependencies(classification);
    setup.dependencies.repoIndexer.fileTreeToPaths = vi.fn(() => ["src/schedule.py"]);
    setup.dependencies.repoIndexer.findRelevantFiles = vi.fn(async () => [{
      path: "src/schedule.py",
      content: "def show_schedule(selected_day):\n    return selected_day or 'all'\n",
      reason: "Classifier selected the schedule behavior"
    }]);
    setup.complete.mockImplementation(async (_systemPrompt, _userMessage, options) => {
      if (options?.requestPhase === "initial-planning") {
        throw new LLMError("Anthropic completion failed: 529 overloaded");
      }
      return JSON.stringify(classification);
    });

    await expect(new FeedbackPipelineWorker(setup.dependencies).process(feedback))
      .rejects.toThrow("529 overloaded");
    expect(setup.createIssue).not.toHaveBeenCalled();
    expect(setup.recordArtifact).not.toHaveBeenCalled();
  });

  it("blocks incomplete intake content even if a disposition override requests a PR", async () => {
    const setup = workerDependencies({
      category: "copy_change",
      complexity: "simple",
      summary: "Update the dashboard label",
      relevantFiles: ["src/dashboard.ts"],
      confidence: 0.99
    });
    const worker = new FeedbackPipelineWorker({
      ...setup.dependencies,
      decideFeedbackDisposition: () => ({
        disposition: "pr",
        reason: "forced direct automation"
      })
    });

    const result = await worker.process({
      ...feedback,
      rawContent: "x".repeat(5_000),
      contentTruncation: {
        originalLength: 5_041,
        retainedLength: 5_000
      }
    });

    expect(setup.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        contentTruncation: {
          originalLength: 5_041,
          retainedLength: 5_000
        }
      }),
      repoContext,
      expect.objectContaining({ reason: expect.stringContaining("incomplete request") })
    );
    expect(setup.dependencies.prCreator.createPR).not.toHaveBeenCalled();
    expect(result.reason).toContain("Created issue #42");
  });

  it("blocks materially disputed classifications even if a disposition override requests a PR", async () => {
    const initialClassification = {
      category: "feature_request",
      complexity: "moderate",
      summary: "Add coordinated dashboard state",
      relevantFiles: ["src/dashboard.ts"],
      confidence: 0.8,
      routingSignals: {
        scope: "multi-component",
        literalCorrection: false,
        runtimeBehavior: true,
        persistentData: false,
        securitySensitive: false,
        requiresHumanReview: false
      }
    };
    const routedClassification = {
      ...initialClassification,
      category: "bug_report",
      complexity: "simple",
      summary: "Fix the dashboard label",
      confidence: 0.99,
      routingSignals: {
        ...initialClassification.routingSignals,
        scope: "localized"
      }
    };
    const setup = workerDependencies(initialClassification);
    let classificationPass = 0;
    setup.complete.mockImplementation(async (_systemPrompt, _userMessage, options) => {
      if (options?.requestPhase === "classification") {
        classificationPass += 1;
        return JSON.stringify(
          classificationPass === 1 ? initialClassification : routedClassification
        );
      }
      throw new Error(`Unexpected LLM phase: ${options?.requestPhase ?? "unknown"}`);
    });
    const worker = new FeedbackPipelineWorker({
      ...setup.dependencies,
      decideFeedbackDisposition: () => ({
        disposition: "pr",
        reason: "forced direct automation"
      })
    });

    const result = await worker.process(feedback);

    expect(setup.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        classificationDisagreement: {
          fields: ["category"]
        }
      }),
      repoContext,
      expect.objectContaining({ reason: expect.stringContaining("materially disagreed") })
    );
    expect(setup.dependencies.prCreator.createPR).not.toHaveBeenCalled();
    expect(result.reason).toContain("Created issue #42");
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

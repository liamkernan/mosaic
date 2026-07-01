import type { ClassifiedFeedback, FeedbackItem, GeneratedChange, RepoContext } from "../../packages/core/src/types.js";
import type { ImplementationPlan } from "../../packages/pipeline/src/implementation-planner.js";
import type { PipelineLlmClient } from "../../packages/pipeline/src/pipeline-llm-client.js";

export function buildFeedbackItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: "01TEST",
    source: "web_form",
    rawContent: "Fix the reported behavior.",
    senderIdentifier: "user@example.com",
    repoFullName: "owner/repo",
    receivedAt: new Date("2026-07-01T12:00:00.000Z"),
    metadata: {},
    ...overrides
  };
}

export function buildClassifiedFeedback(overrides: Partial<ClassifiedFeedback> = {}): ClassifiedFeedback {
  return {
    ...buildFeedbackItem(),
    category: "bug_report",
    complexity: "moderate",
    summary: "Fix the reported behavior",
    relevantFiles: [],
    confidence: 0.8,
    ...overrides
  };
}

export function buildRepoContext(overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    fullName: "owner/repo",
    defaultBranch: "main",
    localPath: process.cwd(),
    fileTree: [],
    installationId: 1,
    ...overrides
  };
}

export function buildGeneratedChange(overrides: Partial<GeneratedChange> = {}): GeneratedChange {
  return {
    filePath: "src/service.ts",
    originalContent: "old\n",
    modifiedContent: "new\n",
    explanation: "update behavior",
    ...overrides
  };
}

export function buildImplementationPlan(overrides: Partial<ImplementationPlan> = {}): ImplementationPlan {
  return {
    requiredFiles: [],
    acceptanceCriteria: [],
    implementationChecklist: [],
    verificationChecklist: [],
    verificationCommands: [],
    ...overrides
  };
}

export function createPipelineLlmClient(complete: PipelineLlmClient["complete"]): PipelineLlmClient {
  return {
    setUsageContext: () => {},
    complete
  };
}

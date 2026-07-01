import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetEnvForTests } from "../packages/core/src/config.js";
import type { ClassifiedFeedback, RepoContext } from "../packages/core/src/types.js";

const { createIssueMock } = vi.hoisted(() => ({
  createIssueMock: vi.fn(async (_input: Record<string, unknown>) => ({ data: { number: 42 } }))
}));

vi.mock("@mosaic/github-app", () => ({
  getOctokit: vi.fn(async () => ({
    rest: { issues: { create: createIssueMock } }
  }))
}));

import { IssueCreator } from "../packages/pipeline/src/issue-creator.js";

const feedback: ClassifiedFeedback = {
  id: "01ISSUE",
  source: "web_form",
  rawContent: "Add a detailed reporting dashboard.",
  senderIdentifier: "user@example.com",
  repoFullName: "owner/repo",
  receivedAt: new Date("2026-07-01T12:00:00.000Z"),
  metadata: {},
  category: "feature_request",
  complexity: "moderate",
  summary: "Add reporting dashboard",
  relevantFiles: ["src/dashboard.ts"],
  confidence: 0.95
};

const repoContext: RepoContext = {
  fullName: "owner/repo",
  defaultBranch: "main",
  localPath: process.cwd(),
  fileTree: [],
  installationId: 7
};

describe("IssueCreator", () => {
  beforeEach(() => {
    vi.stubEnv("MOSAIC_STAGED_ISSUE_SECRET", "test-staged-secret");
    resetEnvForTests();
    createIssueMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  it("creates staged issues with promotion labels and signed metadata", async () => {
    await expect(new IssueCreator().createIssue(feedback, repoContext, {
      reason: "Requires review before implementation.",
      issueMode: "moderate-review-needed"
    })).resolves.toBe(42);

    expect(createIssueMock).toHaveBeenCalledWith(expect.objectContaining({
      owner: "owner",
      repo: "repo",
      title: "[Feedback] Add reporting dashboard",
      labels: expect.arrayContaining([
        "mosaic",
        "needs-human",
        "feature_request",
        "mosaic:staged",
        "mosaic:moderate-review-needed"
      ])
    }));
    const body = createIssueMock.mock.calls[0]?.[0]?.body as string;
    expect(body).toContain("Requires review before implementation.");
    expect(body).toContain("<!-- mosaic:staged-issue ");
    expect(body).toContain("Mosaic");
  });
});

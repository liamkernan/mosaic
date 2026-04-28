import { describe, expect, it } from "vitest";

import {
  buildStagedIssueMetadata,
  buildStagedIssueMetadataComment,
  getModerateIssueMode,
  isFixThisCommand,
  parseStagedIssueMetadata
} from "../packages/pipeline/src/staged-issues.js";

const baseFeedback = {
  id: "01TEST",
  source: "web_form" as const,
  rawContent: "Fix the button text alignment in the settings form.",
  senderIdentifier: "user@example.com",
  repoFullName: "owner/repo",
  receivedAt: new Date("2026-04-27T12:00:00.000Z"),
  metadata: {},
  category: "ui_tweak" as const,
  complexity: "moderate" as const,
  summary: "Fix the button text alignment in the settings form",
  relevantFiles: ["src/settings.tsx"],
  confidence: 0.95
};

describe("staged issues", () => {
  it("encodes and decodes staged issue metadata", () => {
    const metadata = buildStagedIssueMetadata(baseFeedback, "moderate-safe");
    const comment = buildStagedIssueMetadataComment(metadata);

    expect(parseStagedIssueMetadata(comment)).toEqual(metadata);
  });

  it("detects explicit fix-this promotion commands", () => {
    expect(isFixThisCommand("fix this")).toBe(true);
    expect(isFixThisCommand("@feedbackbot fix this")).toBe(true);
    expect(isFixThisCommand("can you fix this later?")).toBe(false);
  });

  it("classifies only narrow moderate issues as safe", () => {
    expect(getModerateIssueMode(baseFeedback)).toBe("moderate-safe");
    expect(
      getModerateIssueMode({
        ...baseFeedback,
        category: "feature_request",
        relevantFiles: ["src/a.ts", "src/b.ts", "src/c.ts"]
      })
    ).toBe("moderate-review-needed");
  });
});

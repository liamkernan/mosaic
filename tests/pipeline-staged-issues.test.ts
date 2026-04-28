import { beforeEach, describe, expect, it } from "vitest";

import {
  buildStagedIssueMetadata,
  buildStagedIssueMetadataComment,
  getPromotionDescription,
  getModerateIssueMode,
  isFixThisCommand,
  parseStagedIssueMetadata
} from "../packages/pipeline/src/staged-issues.js";
import { resetEnvForTests } from "../packages/core/src/config.js";

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
  beforeEach(() => {
    process.env.MOSAIC_TRIGGER_PHRASE = "";
    process.env.FEEDBACKBOT_TRIGGER_PHRASE = "@feedbackbot";
    resetEnvForTests();
  });

  it("encodes and decodes staged issue metadata", () => {
    const metadata = buildStagedIssueMetadata(baseFeedback, "moderate-safe");
    const comment = buildStagedIssueMetadataComment(metadata);

    expect(parseStagedIssueMetadata(comment)).toEqual(metadata);
  });

  it("accepts serialized receivedAt values", () => {
    const metadata = buildStagedIssueMetadata(
      {
        ...baseFeedback,
        receivedAt: "2026-04-27T12:00:00.000Z" as unknown as Date
      },
      "moderate-safe"
    );

    expect(metadata.receivedAt).toBe("2026-04-27T12:00:00.000Z");
  });

  it("detects explicit fix-this promotion commands", () => {
    expect(isFixThisCommand("fix this")).toBe(false);
    expect(isFixThisCommand("@feedbackbot fix this")).toBe(true);
    expect(isFixThisCommand("@FeedbackBot fix this")).toBe(true);
    expect(isFixThisCommand("@feedbackbot please implement this")).toBe(true);
    expect(isFixThisCommand("@feedbackbot open a pull request")).toBe(true);
    expect(isFixThisCommand("@feedbackbot make a PR")).toBe(true);
    expect(isFixThisCommand("can you fix this later?")).toBe(false);
    expect(isFixThisCommand("we should open a PR later")).toBe(false);
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

  it("uses the configured trigger phrase in promotion instructions", () => {
    expect(getPromotionDescription("moderate-safe")).toContain("`@feedbackbot fix this`");
    expect(getPromotionDescription("moderate-review-needed")).toContain("`@feedbackbot open PR`");
  });
});

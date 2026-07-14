import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildStagedIssueMetadata,
  buildStagedIssueMetadataComment,
  getPromotionDescription,
  getModerateIssueMode,
  isFixThisCommand,
  parseStagedIssueMetadata
} from "../packages/pipeline/src/staged-issues.js";
import { resetEnvForTests } from "../packages/core/src/index.js";
import { buildClassifiedFeedback } from "./helpers/pipeline.js";

const baseFeedback = buildClassifiedFeedback({
  rawContent: "Fix the button text alignment in the settings form.",
  receivedAt: new Date("2026-04-27T12:00:00.000Z"),
  category: "ui_tweak",
  complexity: "moderate",
  summary: "Fix the button text alignment in the settings form",
  relevantFiles: ["src/settings.tsx"],
  confidence: 0.95
});
const stagedIssueSecret = "test-staged-secret";

describe("staged issues", () => {
  beforeEach(() => {
    vi.stubEnv("MOSAIC_TRIGGER_PHRASE", "@custombot");
    resetEnvForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  it("encodes and decodes staged issue metadata", () => {
    const metadata = buildStagedIssueMetadata(baseFeedback, "moderate-safe");
    const comment = buildStagedIssueMetadataComment(metadata, stagedIssueSecret);

    expect(parseStagedIssueMetadata(comment, stagedIssueSecret)).toEqual(metadata);
  });

  it("encodes and decodes complex staged issue metadata", () => {
    const metadata = buildStagedIssueMetadata(
      {
        ...baseFeedback,
        category: "feature_request",
        complexity: "complex",
        summary: "Add full journal article pages"
      },
      "complex-review-needed"
    );
    const comment = buildStagedIssueMetadataComment(metadata, stagedIssueSecret);

    expect(parseStagedIssueMetadata(comment, stagedIssueSecret)).toEqual(metadata);
  });

  it("ignores unsigned staged issue metadata comments", () => {
    const metadata = buildStagedIssueMetadata(baseFeedback, "moderate-safe");
    const unsigned = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64");

    expect(parseStagedIssueMetadata(`<!-- mosaic:staged-issue ${unsigned} -->`, stagedIssueSecret)).toBeNull();
  });

  it("uses the last valid signed metadata comment instead of earlier injected markers", () => {
    const injectedMetadata = buildStagedIssueMetadata(
      {
        ...baseFeedback,
        repoFullName: "attacker/repo",
        summary: "Injected metadata"
      },
      "moderate-safe"
    );
    const realMetadata = buildStagedIssueMetadata(baseFeedback, "moderate-safe");
    const injected = buildStagedIssueMetadataComment(injectedMetadata, "wrong-secret");
    const real = buildStagedIssueMetadataComment(realMetadata, stagedIssueSecret);

    expect(parseStagedIssueMetadata(`${injected}\n${real}`, stagedIssueSecret)).toEqual(realMetadata);
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
    expect(isFixThisCommand("@mosaic fix this")).toBe(true);
    expect(isFixThisCommand("@custombot fix this")).toBe(true);
    expect(isFixThisCommand("@CustomBot fix this")).toBe(true);
    expect(isFixThisCommand("@custombot please implement this")).toBe(true);
    expect(isFixThisCommand("@custombot open a pull request")).toBe(true);
    expect(isFixThisCommand("@custombot make a PR")).toBe(true);
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

  it("uses structured risk instead of file count for new moderate classifications", () => {
    const boundedUiState = {
      scope: "multi-component",
      runtimeBehavior: true,
      persistentData: false,
      securitySensitive: false,
      requiresHumanReview: false
    } as const;
    const safeFeedback = {
      ...baseFeedback,
      relevantFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "tests/a.test.ts"],
      routingSignals: boundedUiState
    };

    expect(getModerateIssueMode(safeFeedback)).toBe("moderate-safe");
    expect(getModerateIssueMode({
      ...safeFeedback,
      routingSignals: { ...boundedUiState, persistentData: true }
    })).toBe("moderate-review-needed");
  });

  it("round-trips signed structured routing signals for staged promotion", () => {
    const metadata = buildStagedIssueMetadata({
      ...baseFeedback,
      routingSignals: {
        scope: "multi-component",
        runtimeBehavior: true,
        persistentData: false,
        securitySensitive: false,
        requiresHumanReview: false
      }
    }, "moderate-safe");
    const comment = buildStagedIssueMetadataComment(metadata, stagedIssueSecret);

    expect(parseStagedIssueMetadata(comment, stagedIssueSecret)).toEqual(metadata);
  });

  it("uses the configured trigger phrase in promotion instructions", () => {
    expect(getPromotionDescription("moderate-safe")).toContain("`@custombot fix this`");
    expect(getPromotionDescription("moderate-review-needed")).toContain("`@custombot open PR`");
    expect(getPromotionDescription("complex-review-needed")).toContain("draft pull request");
  });
});

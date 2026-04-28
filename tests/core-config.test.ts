import { beforeEach, describe, expect, it } from "vitest";

import { expandHome, repoFullNamePattern, resetEnvForTests } from "../packages/core/src/config.js";
import { getEnv } from "../packages/core/src/index.js";

describe("core config helpers", () => {
  beforeEach(() => {
    resetEnvForTests();
  });

  it("expands home-prefixed paths", () => {
    expect(expandHome("~/mosaic")).toContain("mosaic");
  });

  it("validates owner/repo names", () => {
    expect(repoFullNamePattern.test("openai/mosaic")).toBe(true);
    expect(repoFullNamePattern.test("not a repo")).toBe(false);
  });

  it("supports legacy FeedbackBot trigger env vars", () => {
    process.env.MOSAIC_TRIGGER_PHRASE = "";
    process.env.FEEDBACKBOT_TRIGGER_PHRASE = "@feedbackbot";
    resetEnvForTests();

    expect(getEnv().MOSAIC_TRIGGER_PHRASE).toBe("@feedbackbot");

    delete process.env.MOSAIC_TRIGGER_PHRASE;
    delete process.env.FEEDBACKBOT_TRIGGER_PHRASE;
    resetEnvForTests();
  });
});

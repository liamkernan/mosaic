import { beforeEach, describe, expect, it } from "vitest";

import { expandHome, repoFullNamePattern, resetEnvForTests } from "../packages/core/src/config.js";

describe("core config helpers", () => {
  beforeEach(() => {
    resetEnvForTests();
  });

  it("expands home-prefixed paths", () => {
    expect(expandHome("~/feedbackbot")).toContain("feedbackbot");
  });

  it("validates owner/repo names", () => {
    expect(repoFullNamePattern.test("openai/feedbackbot")).toBe(true);
    expect(repoFullNamePattern.test("not a repo")).toBe(false);
  });
});

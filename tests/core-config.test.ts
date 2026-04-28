import { beforeEach, describe, expect, it } from "vitest";

import { expandHome, repoFullNamePattern, resetEnvForTests } from "../packages/core/src/config.js";

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
});

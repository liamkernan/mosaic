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

  it("defaults the Mosaic trigger phrase when unset", () => {
    process.env.MOSAIC_TRIGGER_PHRASE = "";
    resetEnvForTests();

    expect(getEnv().MOSAIC_TRIGGER_PHRASE).toBe("@mosaic");

    delete process.env.MOSAIC_TRIGGER_PHRASE;
    resetEnvForTests();
  });
});

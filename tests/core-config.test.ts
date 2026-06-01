import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { expandHome, repoFullNamePattern, resetEnvForTests } from "../packages/core/src/config.js";
import { getEnv } from "../packages/core/src/index.js";

describe("core config helpers", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalRequireSandbox = process.env.VERIFICATION_REQUIRE_SANDBOX;

  beforeEach(() => {
    resetEnvForTests();
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalRequireSandbox === undefined) {
      delete process.env.VERIFICATION_REQUIRE_SANDBOX;
    } else {
      process.env.VERIFICATION_REQUIRE_SANDBOX = originalRequireSandbox;
    }

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

  it("defaults worker stalled-job settings for long-running pipeline jobs", () => {
    delete process.env.WORKER_LOCK_DURATION_MS;
    delete process.env.WORKER_STALLED_INTERVAL_MS;
    delete process.env.WORKER_MAX_STALLED_COUNT;
    resetEnvForTests();

    expect(getEnv().WORKER_LOCK_DURATION_MS).toBe(600_000);
    expect(getEnv().WORKER_STALLED_INTERVAL_MS).toBe(120_000);
    expect(getEnv().WORKER_MAX_STALLED_COUNT).toBe(3);
  });

  it("defaults verification sandbox requirement to production only", () => {
    delete process.env.VERIFICATION_REQUIRE_SANDBOX;

    process.env.NODE_ENV = "production";
    resetEnvForTests();
    expect(getEnv().VERIFICATION_REQUIRE_SANDBOX).toBe(true);

    process.env.NODE_ENV = "development";
    resetEnvForTests();
    expect(getEnv().VERIFICATION_REQUIRE_SANDBOX).toBe(false);
  });

  it("parses explicit verification sandbox booleans", () => {
    process.env.NODE_ENV = "development";

    process.env.VERIFICATION_REQUIRE_SANDBOX = "yes";
    resetEnvForTests();
    expect(getEnv().VERIFICATION_REQUIRE_SANDBOX).toBe(true);

    process.env.VERIFICATION_REQUIRE_SANDBOX = "off";
    resetEnvForTests();
    expect(getEnv().VERIFICATION_REQUIRE_SANDBOX).toBe(false);
  });

  it("rejects invalid verification sandbox booleans", () => {
    process.env.VERIFICATION_REQUIRE_SANDBOX = "definitely";
    resetEnvForTests();

    expect(() => getEnv()).toThrow();
  });
});

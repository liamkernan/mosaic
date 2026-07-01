import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resetEnvForTests } from "../packages/core/src/config.js";
import { loadRepoRuntimeConfig } from "../packages/pipeline/src/repo-config.js";
import { createTempDirTracker } from "./helpers/temp-dirs.js";

const tempDirs = createTempDirTracker();

async function makeRepoConfig(contents?: string): Promise<string> {
  const repoRoot = await tempDirs.create("mosaic-config-test-");
  if (contents) {
    await writeFile(join(repoRoot, "mosaic.config.yml"), contents, "utf8");
  }
  return repoRoot;
}

describe("repo runtime config", () => {
  afterEach(async () => {
    await tempDirs.cleanup();
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  it("defaults the frontend model preset to quality", async () => {
    const repoRoot = await makeRepoConfig();

    await expect(loadRepoRuntimeConfig(repoRoot, "owner/repo")).resolves.toMatchObject({
      llmProvider: "anthropic",
      llmModelPreset: "quality"
    });
  });

  it("uses the global provider switch unless a repo explicitly overrides it", async () => {
    vi.stubEnv("MOSAIC_LLM_PROVIDER", "openai");
    resetEnvForTests();
    const globalRepoRoot = await makeRepoConfig();
    const overriddenRepoRoot = await makeRepoConfig(`
version: 1
llm:
  provider: anthropic
`);

    await expect(loadRepoRuntimeConfig(globalRepoRoot, "owner/global")).resolves.toMatchObject({
      llmProvider: "openai"
    });
    await expect(loadRepoRuntimeConfig(overriddenRepoRoot, "owner/override")).resolves.toMatchObject({
      llmProvider: "anthropic"
    });
  });

  it("parses the frontend model preset from mosaic config", async () => {
    const repoRoot = await makeRepoConfig(`
version: 1
llm:
  provider: openai
  mode: platform
  model_preset: balanced
`);

    await expect(loadRepoRuntimeConfig(repoRoot, "owner/repo")).resolves.toMatchObject({
      llmProvider: "openai",
      llmKeyMode: "platform",
      llmModelPreset: "balanced"
    });
  });

  it("rejects removed model preset values", async () => {
    const repoRoot = await makeRepoConfig(`
version: 1
llm:
  model_preset: fast
`);

    await expect(loadRepoRuntimeConfig(repoRoot, "owner/repo")).rejects.toThrow();
  });
});

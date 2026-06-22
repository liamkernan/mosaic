import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadRepoRuntimeConfig } from "../packages/pipeline/src/repo-config.js";

const tempDirs: string[] = [];

async function makeRepoConfig(contents?: string): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "mosaic-config-test-"));
  tempDirs.push(repoRoot);
  if (contents) {
    await writeFile(join(repoRoot, "mosaic.config.yml"), contents, "utf8");
  }
  return repoRoot;
}

describe("repo runtime config", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("defaults the frontend model preset to quality", async () => {
    const repoRoot = await makeRepoConfig();

    await expect(loadRepoRuntimeConfig(repoRoot, "owner/repo")).resolves.toMatchObject({
      llmModelPreset: "quality"
    });
  });

  it("parses the frontend model preset from mosaic config", async () => {
    const repoRoot = await makeRepoConfig(`
version: 1
llm:
  mode: platform
  model_preset: balanced
`);

    await expect(loadRepoRuntimeConfig(repoRoot, "owner/repo")).resolves.toMatchObject({
      llmKeyMode: "platform",
      llmModelPreset: "balanced"
    });
  });
});

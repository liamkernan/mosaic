import { describe, expect, it } from "vitest";

import { buildClassificationPrompt } from "../packages/pipeline/src/prompts/classify.prompt.js";
import { buildGenerationPrompt } from "../packages/pipeline/src/prompts/generate.prompt.js";

describe("pipeline prompts", () => {
  it("includes feedback and file tree in the classification prompt", () => {
    const prompt = buildClassificationPrompt("Fix the copy", ["src/app.tsx", "README.md"]);
    expect(prompt).toContain("Fix the copy");
    expect(prompt).toContain("src/app.tsx");
  });

  it("includes relevant file contents in the generation prompt", () => {
    const prompt = buildGenerationPrompt(
      "Update header",
      [{ path: "src/header.ts", content: "export const title = 'Old';", reason: "header" }],
      ["src/header.ts"]
    );

    expect(prompt).toContain("Update header");
    expect(prompt).toContain("export const title = 'Old';");
  });
});

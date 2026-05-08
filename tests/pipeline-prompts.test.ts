import { describe, expect, it } from "vitest";

import { buildClassificationPrompt } from "../packages/pipeline/src/prompts/classify.prompt.js";
import { buildGenerationPrompt } from "../packages/pipeline/src/prompts/generate.prompt.js";
import { buildValidationRepairPrompt } from "../packages/pipeline/src/prompts/repair-generate.prompt.js";

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

  it("instructs generation to include styles for modal UI hooks", () => {
    const prompt = buildGenerationPrompt("Add article modals", [], ["index.html", "styles.css"]);

    expect(prompt).toContain("also update the matching stylesheet or script");
    expect(prompt).toContain("matching CSS selectors");
  });

  it("includes validation errors in the validation repair prompt", () => {
    const prompt = buildValidationRepairPrompt(
      "Add article modals",
      [{ path: "index.html", content: "<main></main>" }],
      [{ filePath: "index.html", modifiedContent: "<div class=\"modal-content\"></div>", explanation: "Add modal" }],
      ["Change for index.html adds modal UI hooks but does not update styles.css"],
      ["index.html", "styles.css"]
    );

    expect(prompt).toContain("VALIDATION ERRORS");
    expect(prompt).toContain("modal-content");
    expect(prompt).toContain("include matching CSS selectors");
  });
});

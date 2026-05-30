import { describe, expect, it } from "vitest";

import { buildClassificationPrompt } from "../packages/pipeline/src/prompts/classify.prompt.js";
import { buildGenerationPrompt } from "../packages/pipeline/src/prompts/generate.prompt.js";
import { buildImplementationPlanPrompt } from "../packages/pipeline/src/prompts/implementation-plan.prompt.js";
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
    expect(prompt).toContain("use native <button> or <a>");
    expect(prompt).toContain("href=\"#\"");
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
    expect(prompt).toContain("Replace click-only div/article/section/card containers");
  });

  it("asks implementation planning to include behavior surfaces", () => {
    const prompt = buildImplementationPlanPrompt(
      {
        id: "01TEST",
        source: "web_form",
        rawContent: "Make the journal cards open full articles",
        senderIdentifier: "user@example.com",
        repoFullName: "owner/repo",
        receivedAt: new Date(),
        metadata: {},
        category: "feature_request",
        complexity: "complex",
        summary: "Make journal cards open full articles",
        relevantFiles: ["index.html"],
        confidence: 0.9
      },
      [{ path: "index.html", content: "<button></button>", reason: "classifier" }],
      ["index.html", "styles.css", "script.js"]
    );

    expect(prompt).toContain("scripts/state files");
    expect(prompt).toContain("clickable UI");
    expect(prompt).toContain("Extract every explicit acceptance criterion");
    expect(prompt).toContain("Translate loaded tests into acceptance criteria");
    expect(prompt).toContain("adversarial cases");
    expect(prompt).toContain("implementationChecklist");
    expect(prompt).toContain("acceptanceCriteria");
    expect(prompt).toContain("verificationCommands");
  });

  it("includes implementation plan checklists in generation prompt", () => {
    const prompt = buildGenerationPrompt(
      "Make journal cards open full articles",
      [{ path: "index.html", content: "<button></button>", reason: "classifier" }],
      ["index.html", "script.js"],
      {
        requiredFiles: [{ path: "script.js", reason: "wire click handlers" }],
        acceptanceCriteria: ["Journal cards must open full article content."],
        implementationChecklist: ["Journal cards open and populate full article content."],
        verificationChecklist: ["Click each journal card and confirm modal content changes."],
        verificationCommands: ["pnpm test"]
      }
    );

    expect(prompt).toContain("IMPLEMENTATION PLAN");
    expect(prompt).toContain("Acceptance criteria");
    expect(prompt).toContain("Verification commands");
    expect(prompt).toContain("Journal cards open and populate full article content.");
    expect(prompt).toContain("satisfy every completion checklist item");
    expect(prompt).toContain("Treat loaded tests as executable contracts");
    expect(prompt).toContain("surface actually includes the field/key");
  });

  it("raises completeness expectations for complex generation", () => {
    const prompt = buildGenerationPrompt(
      "Make journal cards open full articles",
      [{ path: "index.html", content: "<button></button>", reason: "classifier" }],
      ["index.html", "script.js"],
      {
        requiredFiles: [{ path: "script.js", reason: "wire click handlers" }],
        acceptanceCriteria: ["Journal cards must open full article content."],
        implementationChecklist: ["Journal cards open and populate full article content."],
        verificationChecklist: ["Click each journal card and confirm modal content changes."],
        verificationCommands: ["pnpm test"]
      },
      { completeSolution: true }
    );

    expect(prompt).toContain("complete, user-visible solution");
    expect(prompt).toContain("Do not use placeholder article text");
    expect(prompt).toContain("A single happy-path example is not enough");
  });
});

import { describe, expect, it } from "vitest";

import { buildClassificationPrompt } from "../packages/pipeline/src/prompts/classify.prompt.js";
import { buildGenerationPrompt } from "../packages/pipeline/src/prompts/generate.prompt.js";
import { buildImplementationPlanPrompt } from "../packages/pipeline/src/prompts/implementation-plan.prompt.js";
import { buildValidationRepairPrompt } from "../packages/pipeline/src/prompts/repair-generate.prompt.js";
import { compactPromptFileTree } from "../packages/pipeline/src/prompts/context-budget.js";

describe("pipeline prompts", () => {
  it("includes feedback and file tree in the classification prompt", () => {
    const prompt = buildClassificationPrompt("Fix the copy", ["src/app.tsx", "README.md"]);
    expect(prompt).toContain("Fix the copy");
    expect(prompt).toContain("src/app.tsx");
    expect(prompt).toContain("README.md");
    expect(prompt).not.toContain("lower-relevance repository path(s) omitted");
  });

  it("compacts large classification file trees while keeping likely relevant paths", () => {
    const fileTree = [
      "README.md",
      "packages/billing/src/invoice-service.ts",
      ...Array.from({ length: 1_400 }, (_, index) => `fixtures/generated/demo-${index}/payload-${index}.json`),
      "tests/reported/invoice-ordering.test.ts"
    ];
    const prompt = buildClassificationPrompt("Fix billing invoice ordering", fileTree);

    expect(prompt).toContain("packages/billing/src/invoice-service.ts");
    expect(prompt).toContain("tests/reported/invoice-ordering.test.ts");
    expect(prompt).toContain("lower-relevance repository path(s) omitted");
    expect(prompt).not.toContain("fixtures/generated/demo-1399/payload-1399.json");
  });

  it("keeps deterministic first-seen paths when compact tree scores tie", () => {
    const compacted = compactPromptFileTree(
      Array.from({ length: 10 }, (_, index) => `src/module-${index}.ts`),
      { maxPaths: 3 }
    );

    expect(compacted.paths).toEqual(["src/module-0.ts", "src/module-1.ts", "src/module-2.ts"]);
    expect(compacted.omittedCount).toBe(7);
  });

  it("keeps nearby files from directly relevant directories", () => {
    const compacted = compactPromptFileTree(
      [
        "src/target.ts",
        "src/neighbor.ts",
        ...Array.from({ length: 20 }, (_, index) => `unrelated/path-${index}.ts`)
      ],
      {
        maxPaths: 2,
        relevantPaths: ["src/target.ts"]
      }
    );

    expect(compacted.paths).toEqual(["src/target.ts", "src/neighbor.ts"]);
  });

  it("keeps nested nearby files from directly relevant directories", () => {
    const compacted = compactPromptFileTree(
      [
        "packages/app/src/target.ts",
        "packages/app/src/neighbor.ts",
        ...Array.from({ length: 20 }, (_, index) => `unrelated/path-${index}.ts`)
      ],
      {
        maxPaths: 2,
        relevantPaths: ["packages/app/src/target.ts"]
      }
    );

    expect(compacted.paths).toEqual(["packages/app/src/target.ts", "packages/app/src/neighbor.ts"]);
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

  it("compacts large generation file trees while keeping relevant paths", () => {
    const fileTree = [
      "src/header.ts",
      ...Array.from({ length: 900 }, (_, index) => `examples/demo-${index}/fixture-${index}.json`),
      "packages/billing/src/invoice-service.ts"
    ];
    const prompt = buildGenerationPrompt(
      "Fix invoice totals",
      [{ path: "packages/billing/src/invoice-service.ts", content: "export function total() {}", reason: "billing logic" }],
      fileTree
    );

    expect(prompt).toContain("packages/billing/src/invoice-service.ts");
    expect(prompt).toContain("lower-relevance repository path(s) omitted");
    expect(prompt).not.toContain("examples/demo-899/fixture-899.json");
  });

  it("instructs generation to include styles for modal UI hooks", () => {
    const prompt = buildGenerationPrompt("Add article modals", [], ["index.html", "styles.css"]);

    expect(prompt).toContain("also update the matching stylesheet or script");
    expect(prompt).toContain("matching CSS selectors");
    expect(prompt).toContain("use native <button> or <a>");
    expect(prompt).toContain("put the required clickable class and data attributes on the native");
    expect(prompt).toContain(".product-card-clickable[data-product-key]");
    expect(prompt).toContain("#collectionModalOverlay");
    expect(prompt).toContain("use localized <edit> operations");
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
    expect(prompt).toContain("Do not plan edits to existing reported/regression tests");
    expect(prompt).toContain("independent companion test");
    expect(prompt).toContain("implementationChecklist");
    expect(prompt).toContain("acceptanceCriteria");
    expect(prompt).toContain("verificationCommands");
    expect(prompt).toContain("dedupe/idempotency/retry bugs");
    expect(prompt).toContain("API/HTTP endpoint requests");
  });

  it("compacts large implementation planning file trees while keeping relevant paths", () => {
    const fileTree = [
      "README.md",
      "packages/billing/src/invoice-service.ts",
      ...Array.from({ length: 2_200 }, (_, index) => `fixtures/generated/demo-${index}/payload-${index}.json`),
      "tests/reported/invoice-ordering.test.ts"
    ];
    const prompt = buildImplementationPlanPrompt(
      {
        id: "01TEST",
        source: "web_form",
        rawContent: "Fix billing invoice ordering",
        senderIdentifier: "user@example.com",
        repoFullName: "owner/repo",
        receivedAt: new Date(),
        metadata: {},
        category: "bug_report",
        complexity: "complex",
        summary: "Fix billing invoice ordering",
        relevantFiles: ["packages/billing/src/invoice-service.ts"],
        confidence: 0.7
      },
      [
        { path: "packages/billing/src/invoice-service.ts", content: "export const invoice = true;", reason: "classifier" },
        { path: "tests/reported/invoice-ordering.test.ts", content: "it('sorts invoices')", reason: "reported test" }
      ],
      fileTree
    );

    expect(prompt).toContain("packages/billing/src/invoice-service.ts");
    expect(prompt).toContain("tests/reported/invoice-ordering.test.ts");
    expect(prompt).toContain("lower-relevance repository path(s) omitted");
    expect(prompt).not.toContain("fixtures/generated/demo-2199/payload-2199.json");
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
    expect(prompt).toContain("If you add a new static JS or CSS file");
    expect(prompt).toContain("satisfy every completion checklist item");
    expect(prompt).toContain("Treat loaded tests as executable contracts");
    expect(prompt).toContain("required files include a test/spec/reported file");
    expect(prompt).toContain("reported/regression test is loaded");
    expect(prompt).toContain("dedupe/idempotency/retry bugs");
    expect(prompt).toContain("API/HTTP endpoint requests");
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
    expect(prompt).toContain("one reusable modal/dialog/overlay");
    expect(prompt).toContain("data-driven behavior");
    expect(prompt).toContain("interactive UI as atomic");
    expect(prompt).toContain("<edit>");
    expect(prompt).toContain("applied atomically in response order");
    expect(prompt).toContain("current in-memory version of that file exactly once");
  });

  it("encourages supplemental assets for large static frontend changes", () => {
    const prompt = buildGenerationPrompt(
      "Add collection modals",
      [
        { path: "index.html", content: "<main></main>".repeat(2_000), reason: "markup" },
        { path: "script.js", content: "console.log('ready');\n".repeat(1_500), reason: "behavior" },
        { path: "styles.css", content: ".item { color: black; }\n".repeat(1_500), reason: "styles" }
      ],
      ["index.html", "script.js", "styles.css"],
      undefined,
      { completeSolution: true }
    );

    expect(prompt).toContain("LARGE STATIC FRONTEND NOTE");
    expect(prompt).toContain("new scoped supplemental JS/CSS files");
  });

  it("adds oversized patch guidance to validation repair prompts", () => {
    const prompt = buildValidationRepairPrompt(
      "Add collection popups",
      [{ path: "index.html", content: "<main></main>" }],
      [{ filePath: "index.html", modifiedContent: "<dialog></dialog>".repeat(300), explanation: "add popups" }],
      ["Total new code added exceeds limit: 418 lines"],
      ["index.html", "script.js", "styles.css"]
    );

    expect(prompt).toContain("OVERSIZED PATCH REPAIR MODE");
    expect(prompt).toContain("one shared overlay/dialog");
    expect(prompt).toContain("aggressively remove duplicated markup");
    expect(prompt).toContain("modal/dialog/overlay behavior is missing");
    expect(prompt).toContain("Do not return HTML/CSS-only repairs");
    expect(prompt).toContain("new static asset is not linked");
    expect(prompt).toContain("script queries missing HTML ids/selectors");
    expect(prompt).toContain("implementation-only and validation reports missing behavioral coverage");
    expect(prompt).toContain("dedupe/idempotency/retry validation failures");
    expect(prompt).toContain("missing endpoint route validation failures");
  });

  it("adds clickable accessibility guidance to validation repair prompts", () => {
    const prompt = buildValidationRepairPrompt(
      "Add product detail cards",
      [
        { path: "index.html", content: "<main></main>" },
        { path: "script.js", content: "console.log('ready');" },
        { path: "styles.css", content: ".product-card { display: block; }" }
      ],
      [
        {
          filePath: "index.html",
          modifiedContent: '<article class="product-card product-card-clickable" data-product-key="sandstone-vase">Sandstone vase</article>',
          explanation: "add clickable card"
        }
      ],
      [
        "Change for index.html makes non-interactive container(s) appear clickable; use native button/link elements or accessible role, tabindex, and keyboard behavior",
        "Total new code added exceeds limit: 413 lines"
      ],
      ["index.html", "script.js", "styles.css"]
    );

    expect(prompt).toContain("CLICKABLE ACCESSIBILITY REPAIR MODE");
    expect(prompt).toContain("moving required clickable classes and data attributes onto the native control");
    expect(prompt).toContain("same repair also has an oversized-patch error");
    expect(prompt).toContain("put those hooks on the native button/link target itself");
  });

  it("compacts large invalid change bodies in validation repair prompts", () => {
    const prompt = buildValidationRepairPrompt(
      "Add compact cards",
      [{ path: "index.html", content: "<main></main>" }],
      [
        {
          filePath: "index.html",
          modifiedContent: ["<main>", ...Array.from({ length: 2_000 }, (_, index) => `<article>${index}</article>`), "</main>"].join("\n"),
          explanation: "add many cards"
        }
      ],
      ["Total new code added exceeds limit: 900 lines"],
      ["index.html"]
    );

    expect(prompt).toContain("invalid generated index.html omitted from repair prompt");
    expect(prompt).toContain("1702 middle line(s)");
    expect(prompt).toContain("<article>0</article>");
    expect(prompt).toContain("<article>1999</article>");
    expect(prompt).not.toContain("<article>1000</article>");
  });
});

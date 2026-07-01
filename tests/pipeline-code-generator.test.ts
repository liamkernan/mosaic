import { describe, expect, it, vi } from "vitest";

import { LLMError } from "../packages/core/src/errors.js";
import { CodeGenerator } from "../packages/pipeline/src/code-generator.js";
import { buildClassifiedFeedback, createPipelineLlmClient } from "./helpers/pipeline.js";

describe("CodeGenerator", () => {
  it("compacts large static JS/CSS prompt context while preserving original diff inputs", async () => {
    let capturedPrompt = "";
    let capturedUserMessage = "";
    const fakeClient = createPipelineLlmClient(async (systemPrompt: string, userMessage: string) => {
      capturedPrompt = systemPrompt;
      capturedUserMessage = userMessage;
      return `<changes>
  <change>
    <filePath>script.js</filePath>
    <modifiedContent><![CDATA[
const generated = true;
]]></modifiedContent>
    <explanation>Add generated script behavior.</explanation>
  </change>
</changes>`;
    });

    const hugeScript = [
      "const firstLine = true;",
      ...Array.from({ length: 2_000 }, (_, index) => `const omitted${index} = ${index};`),
      "const lastLine = true;"
    ].join("\n");
    const hugeStyles = [
      ".first { color: red; }",
      ...Array.from({ length: 2_000 }, (_, index) => `.omitted-${index} { color: black; }`),
      ".last { color: blue; }"
    ].join("\n");

    const generatedChanges = await new CodeGenerator(fakeClient).generate(
      buildClassifiedFeedback({
        rawContent: "Add a popup",
        category: "feature_request",
        complexity: "complex",
        summary: "Add a popup",
        relevantFiles: ["index.html", "script.js", "styles.css"],
        confidence: 0.8
      }),
      [
        { path: "index.html", content: "<main></main>".repeat(2_000), reason: "markup" },
        { path: "script.js", content: hugeScript, reason: "behavior" },
        { path: "styles.css", content: hugeStyles, reason: "styles" }
      ],
      ["index.html", "script.js", "styles.css"],
      undefined,
      { completeSolution: true }
    );

    expect(capturedPrompt).toContain("middle of script.js omitted for generation speed");
    expect(capturedPrompt).toContain("middle of styles.css omitted for generation speed");
    expect(capturedPrompt).toContain("LARGE STATIC FRONTEND NOTE");
    expect(capturedPrompt).toContain("const firstLine = true;");
    expect(capturedPrompt).toContain("const lastLine = true;");
    expect(capturedPrompt).not.toContain("const omitted1000 = 1000;");
    expect(capturedPrompt).not.toContain(".omitted-1000 { color: black; }");
    expect(capturedUserMessage).toContain("use exact <edit> blocks for existing files");
    expect(capturedUserMessage).not.toContain("complete file contents in CDATA blocks");
    expect(generatedChanges).toHaveLength(1);
    expect(generatedChanges[0]?.originalContent).toBe(hugeScript);
  });

  it("compacts oversized source file prompt copies while preserving original diff inputs", async () => {
    let capturedPrompt = "";
    const fakeClient = createPipelineLlmClient(async (systemPrompt: string) => {
      capturedPrompt = systemPrompt;
      return `<changes>
  <edit>
    <filePath>src/service.ts</filePath>
    <search><![CDATA[
export const target = "old";
]]></search>
    <replace><![CDATA[
export const target = "new";
]]></replace>
    <explanation>Update the target value.</explanation>
  </edit>
</changes>`;
    });
    const hugeSource = [
      "export const first = true;",
      ...Array.from({ length: 2_000 }, (_, index) => `export const filler${index} = ${index};`),
      "export const target = \"old\";",
      ...Array.from({ length: 2_000 }, (_, index) => `export const moreFiller${index} = ${index};`),
      "export const last = true;"
    ].join("\n");

    const changes = await new CodeGenerator(fakeClient).generate(
      buildClassifiedFeedback({
        rawContent: "Update target behavior",
        category: "bug_report",
        complexity: "moderate",
        summary: "Update target behavior",
        relevantFiles: ["src/service.ts"],
        confidence: 0.8
      }),
      [{ path: "src/service.ts", content: hugeSource, reason: "implementation" }],
      ["src/service.ts"]
    );

    expect(capturedPrompt).toContain("middle line(s) of src/service.ts omitted from prompt context");
    expect(capturedPrompt).toContain("export const first = true;");
    expect(capturedPrompt).toContain("export const target = \"old\";");
    expect(capturedPrompt).toContain("export const last = true;");
    expect(capturedPrompt).not.toContain("export const filler1000 = 1000;");
    expect(changes[0]?.originalContent).toBe(hugeSource);
    expect(changes[0]?.modifiedContent).toContain('export const target = "new";');
  });

  it("applies exact search replace edits to original files", async () => {
    const fakeClient = createPipelineLlmClient(async () => `<changes>
  <edit>
    <filePath>index.html</filePath>
    <search><![CDATA[
<main><p>Old</p></main>
]]></search>
    <replace><![CDATA[
<main><button type="button">Open details</button></main>
]]></replace>
    <explanation>Replace static copy with an interactive control.</explanation>
  </edit>
</changes>`);

    const changes = await new CodeGenerator(fakeClient).generate(
      buildClassifiedFeedback({
        rawContent: "Add details",
        category: "feature_request",
        complexity: "moderate",
        summary: "Add details",
        relevantFiles: ["index.html"],
        confidence: 0.8
      }),
      [{ path: "index.html", content: "<main><p>Old</p></main>", reason: "markup" }],
      ["index.html"]
    );

    expect(changes).toEqual([
      {
        filePath: "index.html",
        originalContent: "<main><p>Old</p></main>",
        modifiedContent: '<main><button type="button">Open details</button></main>',
        explanation: "Replace static copy with an interactive control."
      }
    ]);
  });

  it.each([
    ["zero matches", "<p>Stale</p>"],
    ["multiple matches", "<p>Repeated</p>"]
  ])("re-anchors structured edits after %s", async (_label, failedSearch) => {
    const complete = vi.fn()
      .mockResolvedValueOnce(`<changes>
  <edit>
    <filePath>index.html</filePath>
    <search><![CDATA[${failedSearch}]]></search>
    <replace><![CDATA[<button>Open</button>]]></replace>
    <explanation>Initial edit.</explanation>
  </edit>
</changes>`)
      .mockResolvedValueOnce(`<changes>
  <edit>
    <filePath>index.html</filePath>
    <search><![CDATA[<main><p>Repeated</p><p>Repeated</p></main>]]></search>
    <replace><![CDATA[<main><button>Open</button></main>]]></replace>
    <explanation>Re-anchor against unique current context.</explanation>
  </edit>
</changes>`);
    const fakeClient = createPipelineLlmClient(complete);

    const changes = await new CodeGenerator(fakeClient).generate(
      buildClassifiedFeedback({
        rawContent: "Add product details",
        category: "feature_request",
        complexity: "complex",
        summary: "Add product details",
        relevantFiles: ["index.html"],
        confidence: 0.8
      }),
      [{ path: "index.html", content: "<main><p>Repeated</p><p>Repeated</p></main>", reason: "markup" }],
      ["index.html"]
    );

    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[0]).toContain("STRUCTURED EDIT APPLICATION ERROR");
    expect(complete.mock.calls[1]?.[0]).toContain("<main><p>Repeated</p><p>Repeated</p></main>");
    expect(changes[0]?.modifiedContent).toBe("<main><button>Open</button></main>");
  });

  it("retries static frontend generation with a lean prompt after an LLM timeout", async () => {
    const prompts: string[] = [];
    const userMessages: string[] = [];
    const timeoutMs: number[] = [];
    const fakeClient = createPipelineLlmClient(async (systemPrompt: string, userMessage: string, options: { timeoutMs?: number }) => {
      prompts.push(systemPrompt);
      userMessages.push(userMessage);
      timeoutMs.push(options.timeoutMs ?? 0);
      if (prompts.length === 1) {
        throw new LLMError(`Anthropic completion timed out after ${options.timeoutMs}ms`);
      }

      return `<changes>
  <change>
    <filePath>script.js</filePath>
    <modifiedContent><![CDATA[
const retrySucceeded = true;
]]></modifiedContent>
    <explanation>Add lean retry behavior.</explanation>
  </change>
</changes>`;
    });

    const changes = await new CodeGenerator(fakeClient).generate(
      buildClassifiedFeedback({
        rawContent: "Make journal guide cards open full articles",
        category: "feature_request",
        complexity: "complex",
        summary: "Make journal guide cards open full article content",
        relevantFiles: ["index.html", "script.js", "styles.css"],
        confidence: 0.8
      }),
      [
        {
          path: "index.html",
          content: [
            "<header>Welcome</header>",
            ...Array.from({ length: 1_000 }, (_, index) => `<div>Filler ${index}</div>`),
            '<section class="journal-section"><button class="journal-card">Shelf styling guide</button></section>',
            ...Array.from({ length: 1_000 }, (_, index) => `<div>More filler ${index}</div>`)
          ].join("\n"),
          reason: "markup"
        },
        { path: "script.js", content: "console.log('ready');", reason: "behavior" },
        { path: "styles.css", content: ".collection { color: black; }\n".repeat(1_000), reason: "styles" }
      ],
      ["index.html", "script.js", "styles.css"],
      undefined,
      { completeSolution: true }
    );

    expect(prompts).toHaveLength(2);
    expect(timeoutMs).toEqual([45_000, 120_000]);
    expect(userMessages[1]).toContain("previous static frontend generation timed out");
    expect(prompts[1]).toContain("middle line(s) of index.html omitted");
    expect(prompts[1]).toContain("journal-section");
    expect(prompts[1]).toContain("LARGE STATIC FRONTEND NOTE");
    expect(changes).toHaveLength(1);
  });

  it("uses compact repair instructions when validation says the patch is too large", async () => {
    let capturedUserMessage = "";
    let capturedMaxTokens = 0;
    let capturedTimeoutMs = 0;
    const fakeClient = createPipelineLlmClient(async (_systemPrompt: string, userMessage: string, options: { maxTokens?: number; timeoutMs?: number }) => {
      capturedUserMessage = userMessage;
      capturedMaxTokens = options.maxTokens ?? 0;
      capturedTimeoutMs = options.timeoutMs ?? 0;
      return `<changes>
  <change>
    <filePath>index.html</filePath>
    <modifiedContent><![CDATA[
<button type="button" data-modal="one">Open</button>
]]></modifiedContent>
    <explanation>Replace duplicated modal markup with compact trigger markup.</explanation>
  </change>
</changes>`;
    });

    await new CodeGenerator(fakeClient).repairValidationFailure(
      buildClassifiedFeedback({
        rawContent: "Add popups",
        category: "feature_request",
        complexity: "complex",
        summary: "Add popups",
        relevantFiles: ["index.html", "script.js", "styles.css"],
        confidence: 0.8
      }),
      [
        { path: "index.html", content: "<main></main>".repeat(2_000), reason: "markup" },
        { path: "script.js", content: "console.log('ready');", reason: "behavior" },
        { path: "styles.css", content: ".collection { color: black; }\n".repeat(1_000), reason: "styles" }
      ],
      ["index.html", "script.js", "styles.css"],
      [
        {
          filePath: "index.html",
          originalContent: "<main></main>",
          modifiedContent: "<main>" + "<dialog></dialog>".repeat(300) + "</main>",
          explanation: "add popups"
        }
      ],
      ["Total new code added exceeds limit: 418 lines"],
      undefined,
      { completeSolution: true }
    );

    expect(capturedUserMessage).toContain("previous patch exceeded validation limits");
    expect(capturedUserMessage).toContain("one reusable data-driven implementation");
    expect(capturedMaxTokens).toBeLessThanOrEqual(12_288);
    expect(capturedTimeoutMs).toBe(120_000);
  });

  it("uses focused syntax repair instructions for parser failures", async () => {
    let capturedUserMessage = "";
    const fakeClient = createPipelineLlmClient(async (_systemPrompt: string, userMessage: string) => {
      capturedUserMessage = userMessage;
      return `<changes>
  <change>
    <filePath>mosaic_demo/service.py</filePath>
    <modifiedContent><![CDATA[
def queue():
    return []
]]></modifiedContent>
    <explanation>Fix Python parser syntax.</explanation>
  </change>
</changes>`;
    });

    await new CodeGenerator(fakeClient).repairValidationFailure(
      buildClassifiedFeedback({
        rawContent: "Queue is broken",
        category: "bug_report",
        complexity: "moderate",
        summary: "Fix support queue behavior",
        relevantFiles: ["mosaic_demo/service.py"],
        confidence: 0.8
      }),
      [{ path: "mosaic_demo/service.py", content: "def queue():\n    return []\n", reason: "implementation" }],
      ["mosaic_demo/service.py"],
      [
        {
          filePath: "mosaic_demo/service.py",
          originalContent: "def queue():\n    return []\n",
          modifiedContent: "def queue(:\n    return []\n",
          explanation: "update queue"
        }
      ],
      ["Syntax validation failed for mosaic_demo/service.py: invalid syntax at line 1, column 11"],
      undefined,
      { completeSolution: true }
    );

    expect(capturedUserMessage).toContain("syntax validity");
    expect(capturedUserMessage).toContain("reported parser error");
    expect(capturedUserMessage).toContain("Do not remove the affected feature");
  });

  it("uses focused script repair instructions when modal behavior is missing", async () => {
    let capturedUserMessage = "";
    let capturedTimeoutMs = 0;
    const fakeClient = createPipelineLlmClient(async (_systemPrompt: string, userMessage: string, options: { timeoutMs?: number }) => {
      capturedUserMessage = userMessage;
      capturedTimeoutMs = options.timeoutMs ?? 0;
      return `<changes>
  <edit>
    <filePath>script.js</filePath>
    <search><![CDATA[
console.log('ready');
]]></search>
    <replace><![CDATA[
console.log('ready');
document.querySelectorAll('[data-collection]').forEach((button) => {
  button.addEventListener('click', () => document.getElementById('collectionModalOverlay').setAttribute('aria-hidden', 'false'));
});
]]></replace>
    <explanation>Wire collection triggers to the modal overlay.</explanation>
  </edit>
</changes>`;
    });

    await new CodeGenerator(fakeClient).repairValidationFailure(
      buildClassifiedFeedback({
        rawContent: "Add collection popups",
        category: "feature_request",
        complexity: "complex",
        summary: "Add collection popups",
        relevantFiles: ["index.html", "script.js", "styles.css"],
        confidence: 0.8
      }),
      [
        { path: "index.html", content: '<main><div id="collectionModalOverlay" aria-hidden="true"></div></main>', reason: "markup" },
        { path: "script.js", content: "console.log('ready');", reason: "behavior" },
        { path: "styles.css", content: ".collection-modal-overlay { display: block; }", reason: "styles" }
      ],
      ["index.html", "script.js", "styles.css"],
      [
        {
          filePath: "index.html",
          originalContent: "<main></main>",
          modifiedContent: '<main><button data-collection="kitchen">Kitchen</button><div id="collectionModalOverlay" class="collection-modal-overlay" aria-hidden="true"></div></main>',
          explanation: "add modal markup"
        }
      ],
      ["Change for index.html adds modal UI hooks without matching behavior in changed scripts: collection-modal-overlay, dialog"],
      undefined,
      { completeSolution: true }
    );

    expect(capturedUserMessage).toContain("focused on missing interactive behavior");
    expect(capturedUserMessage).toContain("opens, populates, closes, and keyboard-wires");
    expect(capturedUserMessage).toContain("do not return HTML/CSS-only repairs");
    expect(capturedTimeoutMs).toBe(120_000);
  });

  it("uses focused hook repair instructions when scripts query missing html", async () => {
    let capturedUserMessage = "";
    const fakeClient = createPipelineLlmClient(async (_systemPrompt: string, userMessage: string) => {
      capturedUserMessage = userMessage;
      return `<changes>
  <edit>
    <filePath>index.html</filePath>
    <search><![CDATA[
<main></main>
]]></search>
    <replace><![CDATA[
<main><button class="coll-card-btn" data-collection="kitchen">Kitchen</button><div id="collectionModal"></div></main>
]]></replace>
    <explanation>Add missing HTML hooks for the modal script.</explanation>
  </edit>
</changes>`;
    });

    await new CodeGenerator(fakeClient).repairValidationFailure(
      buildClassifiedFeedback({
        rawContent: "Add collection popups",
        category: "feature_request",
        complexity: "complex",
        summary: "Add collection popups",
        relevantFiles: ["index.html", "collection-modal.js"],
        confidence: 0.8
      }),
      [
        { path: "index.html", content: "<main></main>", reason: "markup" },
        { path: "collection-modal.js", content: "document.getElementById('collectionModal').hidden = false;", reason: "behavior" }
      ],
      ["index.html", "collection-modal.js"],
      [
        {
          filePath: "collection-modal.js",
          originalContent: "",
          modifiedContent: "document.getElementById('collectionModal').hidden = false;\ndocument.querySelectorAll('.coll-card-btn');",
          explanation: "wire modal"
        }
      ],
      [
        "Change for collection-modal.js queries missing HTML id(s): collectionModal",
        "Change for collection-modal.js queries selector(s) with no matching HTML: .coll-card-btn"
      ],
      undefined,
      { completeSolution: true }
    );

    expect(capturedUserMessage).toContain("mismatched HTML and JavaScript hooks");
    expect(capturedUserMessage).toContain("Add the exact missing ids/classes/data attributes");
    expect(capturedUserMessage).toContain("do not leave selectors that match nothing");
    expect(capturedUserMessage).toContain("native button or link");
    expect(capturedUserMessage).toContain("Enter and Space keyboard handling");
    expect(capturedUserMessage).toContain("Do not merely add a clickable class");
  });

  it("uses focused frontend verification repair instructions for selector assertion failures", async () => {
    let capturedSystemPrompt = "";
    let capturedUserMessage = "";
    let capturedTimeoutMs = 0;
    const fakeClient = createPipelineLlmClient(async (systemPrompt: string, userMessage: string, options: { timeoutMs?: number }) => {
      capturedSystemPrompt = systemPrompt;
      capturedUserMessage = userMessage;
      capturedTimeoutMs = options.timeoutMs ?? 0;
      return `<changes>
  <edit>
    <filePath>index.html</filePath>
    <search><![CDATA[
<main></main>
]]></search>
    <replace><![CDATA[
<main><div id="collectionModalOverlay" aria-hidden="false"><h2 id="modalTitle">Kitchen</h2></div></main>
]]></replace>
    <explanation>Add modal hooks expected by frontend verification.</explanation>
  </edit>
</changes>`;
    });

    await new CodeGenerator(fakeClient).repairValidationFailure(
      buildClassifiedFeedback({
        rawContent: "Add collection popups",
        category: "feature_request",
        complexity: "complex",
        summary: "Add collection popups",
        relevantFiles: ["index.html", "script.js"],
        confidence: 0.8
      }),
      [
        { path: "index.html", content: "<main></main>", reason: "markup" },
        { path: "script.js", content: "console.log('ready');", reason: "behavior" }
      ],
      ["index.html", "script.js"],
      [
        {
          filePath: "index.html",
          originalContent: "<main></main>",
          modifiedContent: '<main><div id="colModalOverlay"></div></main>',
          explanation: "incomplete modal"
        }
      ],
      [
        "Verification failed: Frontend repair requirement: " + JSON.stringify({
          assertion: "Kitchen collection opens a populated modal",
          action: "assert",
          selectorAlternatives: ["#collectionModalOverlay", "#modal-kitchen"],
          expectation: { kind: "class_any", values: ["is-open", "active"] },
          actual: { matchCount: 0 }
        }),
        "Verification failed: Frontend repair requirement: " + JSON.stringify({
          assertion: "Kitchen collection opens a populated modal",
          action: "assert",
          selectorAlternatives: ["#collectionModalProducts > *"],
          expectation: { kind: "min_count", value: 2 },
          actual: { matchCount: 0 }
        })
      ],
      undefined,
      { completeSolution: true }
    );

    expect(capturedUserMessage).toContain("failing frontend verification assertions");
    expect(capturedUserMessage).toContain("selectors, ids, classes, text, attributes, counts");
    expect(capturedUserMessage).toContain("Map existing generated elements to the required selector alternatives");
    expect(capturedUserMessage).toContain("exact compound selector");
    expect(capturedUserMessage).toContain("role, tabindex, and Enter and Space keyboard handling");
    expect(capturedSystemPrompt).toContain('id="colModalOverlay"');
    expect(capturedSystemPrompt).toContain('"selectorAlternatives":["#collectionModalOverlay","#modal-kitchen"]');
    expect(capturedTimeoutMs).toBe(120_000);
  });

  it("uses focused test verification repair instructions without dropping coverage", async () => {
    let capturedUserMessage = "";
    let capturedTimeoutMs = 0;
    const fakeClient = createPipelineLlmClient(async (_systemPrompt: string, userMessage: string, options: { timeoutMs?: number }) => {
      capturedUserMessage = userMessage;
      capturedTimeoutMs = options.timeoutMs ?? 0;
      return `<changes>
  <edit>
    <filePath>tests/reported/test_002_idempotent_external_ref.py</filePath>
    <search><![CDATA[
self.assertIn("screenshot", items[0]["body"])
]]></search>
    <replace><![CDATA[
self.assertIn("screenshot", second["body"])
]]></replace>
    <explanation>Assert the updated body from the returned request object.</explanation>
  </edit>
</changes>`;
    });

    await new CodeGenerator(fakeClient).repairValidationFailure(
      buildClassifiedFeedback({
        rawContent: "Slack retry created duplicate requests",
        category: "bug_report",
        complexity: "moderate",
        summary: "Make source and external reference intake idempotent",
        relevantFiles: ["mosaic_demo/service.py", "tests/reported/test_002_idempotent_external_ref.py"],
        confidence: 0.7
      }),
      [
        { path: "mosaic_demo/service.py", content: "def create_request(): pass\n", reason: "implementation" },
        { path: "tests/reported/test_002_idempotent_external_ref.py", content: "self.assertIn(\"screenshot\", items[0][\"body\"])\n", reason: "test" }
      ],
      ["mosaic_demo/service.py", "tests/reported/test_002_idempotent_external_ref.py"],
      [
        {
          filePath: "tests/reported/test_002_idempotent_external_ref.py",
          originalContent: "self.assertIn(\"screenshot\", items[0][\"body\"])\n",
          modifiedContent: "self.assertIn(\"screenshot\", items[0][\"body\"])\n",
          explanation: "add reported test"
        }
      ],
      [
        "Verification failed: ERROR: test_duplicate_source_external_ref_updates_existing_request (tests.reported.test_002_idempotent_external_ref.IdempotentExternalRefReportedIssueTest.test_duplicate_source_external_ref_updates_existing_request)",
        "Verification failed: KeyError: 'body'"
      ],
      undefined,
      { completeSolution: true }
    );

    expect(capturedUserMessage).toContain("failing test or verification output");
    expect(capturedUserMessage).toContain("Preserve required behavioral test coverage");
    expect(capturedUserMessage).toContain("wrong public API shape");
    expect(capturedTimeoutMs).toBe(120_000);
  });

  it("uses focused idempotency repair instructions when update path is missing", async () => {
    let capturedUserMessage = "";
    const fakeClient = createPipelineLlmClient(async (_systemPrompt: string, userMessage: string) => {
      capturedUserMessage = userMessage;
      return `<changes>
  <edit>
    <filePath>mosaic_demo/service.py</filePath>
    <search><![CDATA[
cursor = conn.execute("INSERT INTO service_requests")
]]></search>
    <replace><![CDATA[
existing = conn.execute("SELECT id FROM service_requests WHERE source = ? AND external_ref = ? AND status = 'open'", (source, external_ref)).fetchone()
if existing:
    conn.execute("UPDATE service_requests SET body = ? WHERE id = ?", (body, existing["id"]))
cursor = conn.execute("INSERT INTO service_requests")
]]></replace>
    <explanation>Lookup and update existing requests before inserting duplicates.</explanation>
  </edit>
</changes>`;
    });

    await new CodeGenerator(fakeClient).repairValidationFailure(
      buildClassifiedFeedback({
        rawContent: "Slack retry created duplicate requests",
        category: "bug_report",
        complexity: "moderate",
        summary: "Make source and external reference intake idempotent",
        relevantFiles: ["mosaic_demo/service.py"],
        confidence: 0.7
      }),
      [{ path: "mosaic_demo/service.py", content: "cursor = conn.execute(\"INSERT INTO service_requests\")\n", reason: "implementation" }],
      ["mosaic_demo/service.py"],
      [
        {
          filePath: "mosaic_demo/service.py",
          originalContent: "cursor = conn.execute(\"INSERT INTO service_requests\")\n",
          modifiedContent: "cursor = conn.execute(\"INSERT INTO service_requests\")\n",
          explanation: "insert request"
        }
      ],
      [
        "Acceptance criteria require an idempotent duplicate/retry update path, but no implementation change appears to look up and update an existing record by the idempotency key"
      ],
      undefined,
      { completeSolution: true }
    );

    expect(capturedUserMessage).toContain("missing idempotent duplicate/retry update path");
    expect(capturedUserMessage).toContain("look up an existing open record by the idempotency key");
    expect(capturedUserMessage).toContain("Include an implementation edit");
    expect(capturedUserMessage).toContain("return it with the same id");
  });

  it("uses focused Python import repair instructions when a new helper is called without import", async () => {
    let capturedUserMessage = "";
    const fakeClient = createPipelineLlmClient(async (_systemPrompt: string, userMessage: string) => {
      capturedUserMessage = userMessage;
      return `<changes>
  <edit>
    <filePath>mosaic_demo/web.py</filePath>
    <search><![CDATA[
from .service import close_request, create_request, get_request, list_requests
]]></search>
    <replace><![CDATA[
from .service import close_request, create_request, get_metrics, get_request, list_requests
]]></replace>
    <explanation>Import the metrics helper used by the route.</explanation>
  </edit>
</changes>`;
    });

    await new CodeGenerator(fakeClient).repairValidationFailure(
      buildClassifiedFeedback({
        rawContent: "Need a dashboard metrics endpoint",
        category: "feature_request",
        complexity: "moderate",
        summary: "Add a support metrics endpoint",
        relevantFiles: ["mosaic_demo/service.py", "mosaic_demo/web.py"],
        confidence: 0.7
      }),
      [
        { path: "mosaic_demo/service.py", content: "def get_metrics(conn):\n    return {}\n", reason: "implementation" },
        { path: "mosaic_demo/web.py", content: "from .service import close_request, create_request, get_request, list_requests\n", reason: "route" }
      ],
      ["mosaic_demo/service.py", "mosaic_demo/web.py"],
      [
        {
          filePath: "mosaic_demo/service.py",
          originalContent: "",
          modifiedContent: "def get_metrics(conn):\n    return {}\n",
          explanation: "add metrics helper"
        },
        {
          filePath: "mosaic_demo/web.py",
          originalContent: "from .service import list_requests\n",
          modifiedContent: "from .service import list_requests\n\ndef route(conn):\n    return get_metrics(conn)\n",
          explanation: "add metrics route"
        }
      ],
      [
        "Change for mosaic_demo/web.py calls get_metrics from service.py but does not import or define get_metrics"
      ],
      undefined,
      { completeSolution: true }
    );

    expect(capturedUserMessage).toContain("missing Python import");
    expect(capturedUserMessage).toContain("Preserve the implementation and tests");
    expect(capturedUserMessage).toContain("newly called sibling-module helper");
  });

  it("uses focused endpoint route repair instructions when a requested path is not handled", async () => {
    let capturedUserMessage = "";
    const fakeClient = createPipelineLlmClient(async (_systemPrompt: string, userMessage: string) => {
      capturedUserMessage = userMessage;
      return `<changes>
  <edit>
    <filePath>mosaic_demo/web.py</filePath>
    <search><![CDATA[
if parsed.path == "/requests":
]]></search>
    <replace><![CDATA[
if parsed.path == "/metrics":
    self.send_json(200, queue_metrics(conn))
    return
if parsed.path == "/requests":
]]></replace>
    <explanation>Route the metrics endpoint to the metrics helper.</explanation>
  </edit>
</changes>`;
    });

    await new CodeGenerator(fakeClient).repairValidationFailure(
      buildClassifiedFeedback({
        rawContent: "Need GET /metrics for dashboard counts",
        category: "feature_request",
        complexity: "moderate",
        summary: "Add a support metrics endpoint",
        relevantFiles: ["mosaic_demo/service.py", "mosaic_demo/web.py"],
        confidence: 0.7
      }),
      [
        { path: "mosaic_demo/service.py", content: "def queue_metrics(conn):\n    return {}\n", reason: "implementation" },
        { path: "mosaic_demo/web.py", content: "if parsed.path == \"/requests\":\n", reason: "route" }
      ],
      ["mosaic_demo/service.py", "mosaic_demo/web.py"],
      [
        {
          filePath: "mosaic_demo/service.py",
          originalContent: "",
          modifiedContent: "def queue_metrics(conn):\n    return {}\n",
          explanation: "add metrics helper"
        },
        {
          filePath: "mosaic_demo/web.py",
          originalContent: "if parsed.path == \"/requests\":\n",
          modifiedContent: "if parsed.path == \"/requests\":\n",
          explanation: "leave route unchanged"
        }
      ],
      [
        "Acceptance criteria require endpoint path /metrics, but no implementation change appears to route or handle that path"
      ],
      undefined,
      { completeSolution: true }
    );

    expect(capturedUserMessage).toContain("missing endpoint route");
    expect(capturedUserMessage).toContain("exact requested HTTP path");
    expect(capturedUserMessage).toContain("falling through to not found");
  });

  it("uses focused runtime implementation repair instructions for tests-only fixes", async () => {
    let capturedUserMessage = "";
    const fakeClient = createPipelineLlmClient(async (_systemPrompt: string, userMessage: string) => {
      capturedUserMessage = userMessage;
      return `<changes>
  <edit>
    <filePath>mosaic_demo/service.py</filePath>
    <search><![CDATA[
order_by = "sr.created_at ASC"
]]></search>
    <replace><![CDATA[
order_by = "sr.sla_due_at ASC, sr.created_at ASC"
]]></replace>
    <explanation>Fix SLA queue ordering in the runtime service.</explanation>
  </edit>
</changes>`;
    });

    await new CodeGenerator(fakeClient).repairValidationFailure(
      buildClassifiedFeedback({
        rawContent: "SLA sorting is wrong",
        category: "bug_report",
        complexity: "moderate",
        summary: "Fix SLA sort ordering",
        relevantFiles: ["mosaic_demo/service.py", "tests/reported/test_001_sla_sort.py"],
        confidence: 0.7
      }),
      [
        { path: "mosaic_demo/service.py", content: "order_by = \"sr.created_at ASC\"\n", reason: "implementation" },
        { path: "tests/reported/test_001_sla_sort.py", content: "def test_sla(): pass\n", reason: "coverage" }
      ],
      ["mosaic_demo/service.py", "tests/reported/test_001_sla_sort.py"],
      [
        {
          filePath: "tests/reported/test_001_sla_sort.py",
          originalContent: "def test_sla(): pass\n",
          modifiedContent: "def test_sla_sort_orders_by_due_at(): assert True\n",
          explanation: "add regression test"
        }
      ],
      [
        "Implementation plan requires runtime/source changes, but the generated change only modifies tests or documentation"
      ],
      undefined,
      { completeSolution: true }
    );

    expect(capturedUserMessage).toContain("missing runtime/source implementation");
    expect(capturedUserMessage).toContain("actual application source files");
    expect(capturedUserMessage).toContain("do not return tests/docs-only repairs");
  });

  it("uses focused test integrity repair instructions for weakened tests", async () => {
    let capturedUserMessage = "";
    const fakeClient = createPipelineLlmClient(async (_systemPrompt: string, userMessage: string) => {
      capturedUserMessage = userMessage;
      return `<changes>
  <edit>
    <filePath>mosaic_demo/service.py</filePath>
    <search><![CDATA[
order_by = "sr.created_at ASC"
]]></search>
    <replace><![CDATA[
order_by = "sr.sla_due_at ASC, sr.created_at ASC"
]]></replace>
    <explanation>Fix SLA queue ordering while preserving the reported test.</explanation>
  </edit>
</changes>`;
    });

    await new CodeGenerator(fakeClient).repairValidationFailure(
      buildClassifiedFeedback({
        rawContent: "SLA sorting is wrong",
        category: "bug_report",
        complexity: "moderate",
        summary: "Fix SLA sort ordering",
        relevantFiles: ["mosaic_demo/service.py", "tests/reported/test_001_sla_sort.py"],
        confidence: 0.7
      }),
      [
        { path: "mosaic_demo/service.py", content: "order_by = \"sr.created_at ASC\"\n", reason: "implementation" },
        { path: "tests/reported/test_001_sla_sort.py", content: "self.assertEqual(urgent['id'], queue[0]['id'])\n", reason: "coverage" }
      ],
      ["mosaic_demo/service.py", "tests/reported/test_001_sla_sort.py"],
      [
        {
          filePath: "tests/reported/test_001_sla_sort.py",
          originalContent: "self.assertEqual(urgent['id'], queue[0]['id'])\n",
          modifiedContent: "assert True\n",
          explanation: "weaken test"
        }
      ],
      [
        "Change for tests/reported/test_001_sla_sort.py weakens existing test assertions (1 -> 0)"
      ],
      undefined,
      { completeSolution: true }
    );

    expect(capturedUserMessage).toContain("test integrity");
    expect(capturedUserMessage).toContain("Restore the original meaningful assertions");
    expect(capturedUserMessage).toContain("fix the application implementation");
  });
});

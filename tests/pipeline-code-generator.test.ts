import { describe, expect, it } from "vitest";

import { LLMError } from "../packages/core/src/errors.js";
import type { LLMClient } from "../packages/llm/src/client.js";
import { CodeGenerator } from "../packages/pipeline/src/code-generator.js";

describe("CodeGenerator", () => {
  it("compacts large static JS/CSS prompt context while preserving original diff inputs", async () => {
    let capturedPrompt = "";
    const fakeClient = {
      setUsageContext: () => {},
      complete: async (systemPrompt: string) => {
        capturedPrompt = systemPrompt;
        return `<changes>
  <change>
    <filePath>script.js</filePath>
    <modifiedContent><![CDATA[
const generated = true;
]]></modifiedContent>
    <explanation>Add generated script behavior.</explanation>
  </change>
</changes>`;
      }
    } as unknown as LLMClient;

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
      {
        id: "01TEST",
        source: "web_form",
        rawContent: "Add a popup",
        senderIdentifier: "user@example.com",
        repoFullName: "owner/repo",
        receivedAt: new Date(),
        metadata: {},
        category: "feature_request",
        complexity: "complex",
        summary: "Add a popup",
        relevantFiles: ["index.html", "script.js", "styles.css"],
        confidence: 0.8
      },
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
    expect(generatedChanges).toHaveLength(1);
    expect(generatedChanges[0]?.originalContent).toBe(hugeScript);
  });

  it("applies exact search replace edits to original files", async () => {
    const fakeClient = {
      setUsageContext: () => {},
      complete: async () => `<changes>
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
</changes>`
    } as unknown as LLMClient;

    const changes = await new CodeGenerator(fakeClient).generate(
      {
        id: "01TEST",
        source: "web_form",
        rawContent: "Add details",
        senderIdentifier: "user@example.com",
        repoFullName: "owner/repo",
        receivedAt: new Date(),
        metadata: {},
        category: "feature_request",
        complexity: "moderate",
        summary: "Add details",
        relevantFiles: ["index.html"],
        confidence: 0.8
      },
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

  it("retries static frontend generation with a lean prompt after an LLM timeout", async () => {
    const prompts: string[] = [];
    const userMessages: string[] = [];
    const fakeClient = {
      setUsageContext: () => {},
      complete: async (systemPrompt: string, userMessage: string) => {
        prompts.push(systemPrompt);
        userMessages.push(userMessage);
        if (prompts.length === 1) {
          throw new LLMError("Anthropic completion timed out after 180000ms");
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
      }
    } as unknown as LLMClient;

    const changes = await new CodeGenerator(fakeClient).generate(
      {
        id: "01TEST",
        source: "web_form",
        rawContent: "Add a collection modal",
        senderIdentifier: "user@example.com",
        repoFullName: "owner/repo",
        receivedAt: new Date(),
        metadata: {},
        category: "feature_request",
        complexity: "complex",
        summary: "Add a collection modal",
        relevantFiles: ["index.html", "script.js", "styles.css"],
        confidence: 0.8
      },
      [
        { path: "index.html", content: "<main></main>".repeat(2_000), reason: "markup" },
        { path: "script.js", content: "console.log('ready');", reason: "behavior" },
        { path: "styles.css", content: ".collection { color: black; }\n".repeat(1_000), reason: "styles" }
      ],
      ["index.html", "script.js", "styles.css"],
      undefined,
      { completeSolution: true }
    );

    expect(prompts).toHaveLength(2);
    expect(userMessages[1]).toContain("previous static frontend generation timed out");
    expect(prompts[1]).toContain("LARGE STATIC FRONTEND NOTE");
    expect(changes).toHaveLength(1);
  });

  it("uses compact repair instructions when validation says the patch is too large", async () => {
    let capturedUserMessage = "";
    let capturedMaxTokens = 0;
    let capturedTimeoutMs = 0;
    const fakeClient = {
      setUsageContext: () => {},
      complete: async (_systemPrompt: string, userMessage: string, options: { maxTokens?: number; timeoutMs?: number }) => {
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
      }
    } as unknown as LLMClient;

    await new CodeGenerator(fakeClient).repairValidationFailure(
      {
        id: "01TEST",
        source: "web_form",
        rawContent: "Add popups",
        senderIdentifier: "user@example.com",
        repoFullName: "owner/repo",
        receivedAt: new Date(),
        metadata: {},
        category: "feature_request",
        complexity: "complex",
        summary: "Add popups",
        relevantFiles: ["index.html", "script.js", "styles.css"],
        confidence: 0.8
      },
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

  it("uses focused script repair instructions when modal behavior is missing", async () => {
    let capturedUserMessage = "";
    let capturedTimeoutMs = 0;
    const fakeClient = {
      setUsageContext: () => {},
      complete: async (_systemPrompt: string, userMessage: string, options: { timeoutMs?: number }) => {
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
      }
    } as unknown as LLMClient;

    await new CodeGenerator(fakeClient).repairValidationFailure(
      {
        id: "01TEST",
        source: "web_form",
        rawContent: "Add collection popups",
        senderIdentifier: "user@example.com",
        repoFullName: "owner/repo",
        receivedAt: new Date(),
        metadata: {},
        category: "feature_request",
        complexity: "complex",
        summary: "Add collection popups",
        relevantFiles: ["index.html", "script.js", "styles.css"],
        confidence: 0.8
      },
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
    const fakeClient = {
      setUsageContext: () => {},
      complete: async (_systemPrompt: string, userMessage: string) => {
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
      }
    } as unknown as LLMClient;

    await new CodeGenerator(fakeClient).repairValidationFailure(
      {
        id: "01TEST",
        source: "web_form",
        rawContent: "Add collection popups",
        senderIdentifier: "user@example.com",
        repoFullName: "owner/repo",
        receivedAt: new Date(),
        metadata: {},
        category: "feature_request",
        complexity: "complex",
        summary: "Add collection popups",
        relevantFiles: ["index.html", "collection-modal.js"],
        confidence: 0.8
      },
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
  });

  it("uses focused frontend verification repair instructions for selector assertion failures", async () => {
    let capturedUserMessage = "";
    let capturedTimeoutMs = 0;
    const fakeClient = {
      setUsageContext: () => {},
      complete: async (_systemPrompt: string, userMessage: string, options: { timeoutMs?: number }) => {
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
      }
    } as unknown as LLMClient;

    await new CodeGenerator(fakeClient).repairValidationFailure(
      {
        id: "01TEST",
        source: "web_form",
        rawContent: "Add collection popups",
        senderIdentifier: "user@example.com",
        repoFullName: "owner/repo",
        receivedAt: new Date(),
        metadata: {},
        category: "feature_request",
        complexity: "complex",
        summary: "Add collection popups",
        relevantFiles: ["index.html", "script.js"],
        confidence: 0.8
      },
      [
        { path: "index.html", content: "<main></main>", reason: "markup" },
        { path: "script.js", content: "console.log('ready');", reason: "behavior" }
      ],
      ["index.html", "script.js"],
      [
        {
          filePath: "index.html",
          originalContent: "<main></main>",
          modifiedContent: "<main></main>",
          explanation: "incomplete modal"
        }
      ],
      [
        "Verification failed: Kitchen collection opens a populated modal: expected element not found: #collectionModalOverlay",
        "Verification failed: Kitchen collection opens a populated modal: expected at least 2 matches for #collectionModalProducts > *, found 0"
      ],
      undefined,
      { completeSolution: true }
    );

    expect(capturedUserMessage).toContain("failing frontend verification assertions");
    expect(capturedUserMessage).toContain("selectors, ids, classes, text, attributes, counts");
    expect(capturedTimeoutMs).toBe(120_000);
  });
});

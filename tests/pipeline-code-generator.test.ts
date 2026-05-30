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
});

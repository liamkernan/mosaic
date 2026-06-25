import type { RelevantFile } from "@mosaic/core";
import type { ImplementationPlan } from "../implementation-planner.js";
import { formatPromptFileBlocks, formatPromptFileTree, promptFilePaths } from "./context-budget.js";

export function buildGenerationPrompt(
  summary: string,
  relevantFiles: RelevantFile[],
  fileTree: string[],
  implementationPlan?: ImplementationPlan,
  options: { completeSolution?: boolean } = {}
): string {
  const promptFileTree = formatPromptFileTree(fileTree, {
    maxPaths: 450,
    summary,
    relevantPaths: promptFilePaths(relevantFiles),
    planPaths: implementationPlan?.requiredFiles.map((file) => file.path)
  });
  const planSection = implementationPlan
    ? `\nIMPLEMENTATION PLAN:\nRequired files:\n${implementationPlan.requiredFiles.map((file) => `- ${file.path}: ${file.reason}`).join("\n")}\n\nAcceptance criteria:\n${implementationPlan.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}\n\nCompletion checklist:\n${implementationPlan.implementationChecklist.map((item) => `- ${item}`).join("\n")}\n\nVerification checklist:\n${implementationPlan.verificationChecklist.map((item) => `- ${item}`).join("\n")}\n\nVerification commands:\n${implementationPlan.verificationCommands.map((item) => `- ${item}`).join("\n")}\n`
    : "";
  let staticFrontendBytes = 0;
  let hasCompactedStaticFrontendContext = false;
  for (const file of relevantFiles) {
    if (/\.(?:html?|css|[cm]?js)$/i.test(file.path)) {
      staticFrontendBytes += Buffer.byteLength(file.content);
    }
    if (!hasCompactedStaticFrontendContext) {
      hasCompactedStaticFrontendContext =
        file.reason?.includes("compacted large static asset context") === true ||
        file.content.includes("MOSAIC CONTEXT NOTE");
    }
  }
  const largeStaticFrontendSection = staticFrontendBytes > 45_000 || hasCompactedStaticFrontendContext
    ? "\nLARGE STATIC FRONTEND NOTE:\n- This appears to be a large static HTML/CSS/JS site. To avoid rewriting large existing assets, prefer the smallest durable integration: make a minimal HTML hook/link/script insertion and add new scoped supplemental JS/CSS files for the feature when that satisfies the request.\n- Do not duplicate large existing files unless the existing file itself must change extensively.\n"
    : "";

  return `You are a senior software engineer implementing a user-requested change in a codebase.

USER REQUEST: ${summary}

REPOSITORY FILE TREE:
${promptFileTree}

RELEVANT FILES:
${formatPromptFileBlocks(relevantFiles)}
${planSection}
${largeStaticFrontendSection}

INSTRUCTIONS:
- ${options.completeSolution ? "Implement a complete, user-visible solution in one pass. Do not stop at scaffolding, placeholder content, or a partial happy-path patch." : "Implement the requested change with minimal modifications."}
- Preserve the existing code style, indentation, and conventions EXACTLY.
- Only modify files that need to change. Do not refactor unrelated code.
- If an implementation plan is provided, satisfy every completion checklist item or return <changes></changes>.
- Treat every acceptance criterion from the implementation plan as binding. Do not silently weaken, reinterpret, or replace it.
- Treat loaded tests as executable contracts. Before editing, identify every asserted field/key/status/return value/side effect in relevant tests and make the implementation satisfy those assertions.
- For moderate or complex requests, prefer coherent complete behavior over the smallest possible diff, while still avoiding unrelated refactors.
- If you add a new static JS or CSS file to an HTML site, update the HTML to load it with a matching <script src> or <link rel="stylesheet"> tag in the same response.
- Add or update focused tests when the repository has a relevant test pattern and the request changes behavior.
- If the implementation plan required files include a test/spec/reported file for a behavioral request, the response must modify at least one matching test file in the same change set.
- If a reported/regression test is loaded for a behavioral bug, do not rely on it unchanged in complete-solution mode; extend it with a missing edge case or add a repository-native companion test, and return that test edit with the implementation.
- For sort/order/filter/ranking changes, cover the primary behavior and every stated tie-breaker with adversarial tests. A single happy-path example is not enough.
- For dedupe/idempotency/retry bugs, implement the lookup/update path before insert/create, preserve the existing record identity when the stated idempotency key matches, preserve distinct record creation when the key is absent or different, and test both duplicate and non-duplicate paths.
- For API/HTTP endpoint requests, update both the routing/handler surface and the backing service/data surface. Tests should exercise the public route path, not only the helper function.
- If an acceptance criterion names exact fields, keys, ordering clauses, or tie-breakers, implement those exact terms. You may add a deterministic tertiary tie-breaker only after all required keys.
- If an existing or planned test reads a field/key from a list, query, API response, or returned object, make sure that surface actually includes the field/key.
- Do not use placeholder article text, placeholder data, inert buttons, empty handlers, or UI that appears clickable but does not complete the requested workflow.
- For repeated cards/items/popups, implement one reusable modal/dialog/overlay and populate it from compact data in JavaScript or existing data attributes. Do not duplicate full modal markup for every item.
- Keep static frontend changes compact enough to pass validation limits; prefer data-driven behavior and scoped selectors over hundreds of lines of repeated HTML.
- Treat interactive UI as atomic: if you add modal/dialog/overlay markup or clickable triggers, the same response must include the JavaScript that opens, populates, closes, and keyboard-wires that UI using the exact ids/classes/data attributes from the markup.
- For clickable UI, use native <button> or <a> elements whenever possible. Do not attach click-only behavior to plain div/article/section/card containers unless you also make them accessible with role, tabindex, and keyboard handling.
- Do not leave visible links with href="#" or javascript:void(0). If a link or control is visible, it must navigate, submit, open the intended UI, or be removed.
- If you add or change UI classes, ids, modal/dialog/overlay markup, or interactive HTML hooks, also update the matching stylesheet or script in the same response so the UI is complete.
- Do not introduce modal, dialog, or overlay classes such as modal-content unless the response also includes matching CSS selectors for every new modal/dialog/overlay class.
- If the request is ambiguous, choose the most conservative interpretation.
- Do NOT add comments like '// Added by Mosaic' or '// Changed'.
- Return ONLY the response format below. No markdown fences. No prose before or after.
- For existing files, prefer the exact <edit> search/replace form when the change is localized. Use <change> with complete updated file contents only when search/replace cannot express the edit safely or when creating a new file.
- Every <edit> search block must match the original file exactly once. Include enough surrounding context to make it unique.
- Put complete updated file contents or search/replace blocks inside CDATA so you do not need to escape quotes or newlines.
- If you genuinely cannot implement this change safely, return exactly <changes></changes>.

Respond ONLY in this format:
<changes>
  <edit>
    <filePath>relative/path/to/existing-file.ext</filePath>
    <search><![CDATA[
...exact original text to replace...
]]></search>
    <replace><![CDATA[
...replacement text...
]]></replace>
    <explanation>One sentence explaining what you changed and why.</explanation>
  </edit>
  <change>
    <filePath>relative/path/to/file.ext</filePath>
    <modifiedContent><![CDATA[
...full file content with changes applied...
]]></modifiedContent>
    <explanation>One sentence explaining what you changed and why.</explanation>
  </change>
</changes>`;
}

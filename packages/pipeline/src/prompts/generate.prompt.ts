import type { RelevantFile } from "@mosaic/core";
import type { ImplementationPlan } from "../implementation-planner.js";

export function buildGenerationPrompt(
  summary: string,
  relevantFiles: RelevantFile[],
  fileTree: string[],
  implementationPlan?: ImplementationPlan,
  options: { completeSolution?: boolean } = {}
): string {
  const planSection = implementationPlan
    ? `\nIMPLEMENTATION PLAN:\nRequired files:\n${implementationPlan.requiredFiles.map((file) => `- ${file.path}: ${file.reason}`).join("\n")}\n\nAcceptance criteria:\n${implementationPlan.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}\n\nCompletion checklist:\n${implementationPlan.implementationChecklist.map((item) => `- ${item}`).join("\n")}\n\nVerification checklist:\n${implementationPlan.verificationChecklist.map((item) => `- ${item}`).join("\n")}\n\nVerification commands:\n${implementationPlan.verificationCommands.map((item) => `- ${item}`).join("\n")}\n`
    : "";

  return `You are a senior software engineer implementing a user-requested change in a codebase.

USER REQUEST: ${summary}

REPOSITORY FILE TREE:
${fileTree.join("\n")}

RELEVANT FILES:
${relevantFiles.map((file) => `--- ${file.path} ---\n${file.content}\n--- END ${file.path} ---`).join("\n\n")}
${planSection}

INSTRUCTIONS:
- ${options.completeSolution ? "Implement a complete, user-visible solution in one pass. Do not stop at scaffolding, placeholder content, or a partial happy-path patch." : "Implement the requested change with minimal modifications."}
- Preserve the existing code style, indentation, and conventions EXACTLY.
- Only modify files that need to change. Do not refactor unrelated code.
- If an implementation plan is provided, satisfy every completion checklist item or return <changes></changes>.
- Treat every acceptance criterion from the implementation plan as binding. Do not silently weaken, reinterpret, or replace it.
- Treat loaded tests as executable contracts. Before editing, identify every asserted field/key/status/return value/side effect in relevant tests and make the implementation satisfy those assertions.
- For moderate or complex requests, prefer coherent complete behavior over the smallest possible diff, while still avoiding unrelated refactors.
- Add or update focused tests when the repository has a relevant test pattern and the request changes behavior.
- For sort/order/filter/ranking changes, cover the primary behavior and every stated tie-breaker with adversarial tests. A single happy-path example is not enough.
- If an acceptance criterion names exact fields, keys, ordering clauses, or tie-breakers, implement those exact terms. You may add a deterministic tertiary tie-breaker only after all required keys.
- If an existing or planned test reads a field/key from a list, query, API response, or returned object, make sure that surface actually includes the field/key.
- Do not use placeholder article text, placeholder data, inert buttons, empty handlers, or UI that appears clickable but does not complete the requested workflow.
- For clickable UI, use native <button> or <a> elements whenever possible. Do not attach click-only behavior to plain div/article/section/card containers unless you also make them accessible with role, tabindex, and keyboard handling.
- Do not leave visible links with href="#" or javascript:void(0). If a link or control is visible, it must navigate, submit, open the intended UI, or be removed.
- If you add or change UI classes, ids, modal/dialog/overlay markup, or interactive HTML hooks, also update the matching stylesheet or script in the same response so the UI is complete.
- Do not introduce modal, dialog, or overlay classes such as modal-content unless the response also includes matching CSS selectors for every new modal/dialog/overlay class.
- If the request is ambiguous, choose the most conservative interpretation.
- Do NOT add comments like '// Added by Mosaic' or '// Changed'.
- Return ONLY the response format below. No markdown fences. No prose before or after.
- Put the complete updated file contents inside CDATA so you do not need to escape quotes or newlines.
- If you genuinely cannot implement this change safely, return exactly <changes></changes>.

Respond ONLY in this format:
<changes>
  <change>
    <filePath>relative/path/to/file.ext</filePath>
    <modifiedContent><![CDATA[
...full file content with changes applied...
]]></modifiedContent>
    <explanation>One sentence explaining what you changed and why.</explanation>
  </change>
</changes>`;
}

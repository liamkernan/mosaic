import type { RelevantFile } from "@mosaic/core";
import type { ImplementationPlan } from "../implementation-planner.js";

export function buildGenerationPrompt(
  summary: string,
  relevantFiles: RelevantFile[],
  fileTree: string[],
  implementationPlan?: ImplementationPlan
): string {
  const planSection = implementationPlan
    ? `\nIMPLEMENTATION PLAN:\nRequired files:\n${implementationPlan.requiredFiles.map((file) => `- ${file.path}: ${file.reason}`).join("\n")}\n\nCompletion checklist:\n${implementationPlan.implementationChecklist.map((item) => `- ${item}`).join("\n")}\n\nVerification checklist:\n${implementationPlan.verificationChecklist.map((item) => `- ${item}`).join("\n")}\n`
    : "";

  return `You are a senior software engineer implementing a user-requested change in a codebase.

USER REQUEST: ${summary}

REPOSITORY FILE TREE:
${fileTree.join("\n")}

RELEVANT FILES:
${relevantFiles.map((file) => `--- ${file.path} ---\n${file.content}\n--- END ${file.path} ---`).join("\n\n")}
${planSection}

INSTRUCTIONS:
- Implement the requested change with minimal modifications.
- Preserve the existing code style, indentation, and conventions EXACTLY.
- Only modify files that need to change. Do not refactor unrelated code.
- If an implementation plan is provided, satisfy every completion checklist item or return <changes></changes>.
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

export function buildGenerationRepairPrompt(rawResponse: string): string {
  return `You repair malformed structured file-change output produced by another model.

Your job:
- Return ONLY a valid <changes>...</changes> payload.
- Preserve the intended content exactly.
- Do not summarize.
- Do not drop fields.
- Put complete file contents inside <![CDATA[ ... ]]> blocks.
- If the content is too incomplete to repair safely, return exactly <changes></changes>.

Malformed response:
<RAW_RESPONSE>
${rawResponse}
</RAW_RESPONSE>`;
}

export function buildValidationRepairPrompt(
  summary: string,
  relevantFiles: Array<{ path: string; content: string }>,
  currentChanges: Array<{ filePath: string; modifiedContent: string; explanation: string }>,
  validationErrors: string[],
  fileTree: string[],
  implementationPlan?: {
    requiredFiles: Array<{ path: string; reason: string }>;
    acceptanceCriteria: string[];
    implementationChecklist: string[];
    verificationChecklist: string[];
    verificationCommands: string[];
  }
): string {
  const planSection = implementationPlan
    ? `\nIMPLEMENTATION PLAN:\nRequired files:\n${implementationPlan.requiredFiles.map((file) => `- ${file.path}: ${file.reason}`).join("\n")}\n\nAcceptance criteria:\n${implementationPlan.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}\n\nCompletion checklist:\n${implementationPlan.implementationChecklist.map((item) => `- ${item}`).join("\n")}\n\nVerification checklist:\n${implementationPlan.verificationChecklist.map((item) => `- ${item}`).join("\n")}\n\nVerification commands:\n${implementationPlan.verificationCommands.map((item) => `- ${item}`).join("\n")}\n`
    : "";

  return `You are repairing a generated code change that failed validation.

USER REQUEST: ${summary}

VALIDATION ERRORS:
${validationErrors.map((error) => `- ${error}`).join("\n")}

REPOSITORY FILE TREE:
${fileTree.join("\n")}
${planSection}

ORIGINAL RELEVANT FILES:
${relevantFiles.map((file) => `--- ${file.path} ---\n${file.content}\n--- END ${file.path} ---`).join("\n\n")}

CURRENT INVALID CHANGES:
${currentChanges.map((change) => `--- ${change.filePath} ---\n${change.modifiedContent}\n--- END ${change.filePath} ---\nExplanation: ${change.explanation}`).join("\n\n")}

INSTRUCTIONS:
- Return a corrected complete change set that satisfies every validation error.
- Preserve useful parts of the current invalid changes when safe.
- Treat acceptance criteria as binding. If they name exact fields, keys, ordering clauses, or tie-breakers, implement those exact terms.
- Treat loaded tests and verification failures as executable contracts. If a failure is a missing field/key/status/return value, update the implementation surface that should provide it.
- Add or update focused tests when validation reports missing behavioral coverage or the plan verification checklist requires tests.
- For sort/order/filter/ranking changes, cover the primary behavior and every stated tie-breaker with adversarial tests.
- Replace click-only div/article/section/card containers with native buttons or links where possible; otherwise add role, tabindex, and keyboard handling.
- Remove or wire any visible href="#" or javascript:void(0) links so every visible control performs the requested workflow.
- If HTML adds modal/dialog/overlay classes or hooks, include matching CSS selectors in the stylesheet in the same response.
- If JavaScript is needed for new interactive UI, include the matching script changes in the same response.
- Return ONLY the response format below. No markdown fences. No prose before or after.
- Put complete updated file contents inside CDATA blocks.
- If you cannot repair safely, return exactly <changes></changes>.

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

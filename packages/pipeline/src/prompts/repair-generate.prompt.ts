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
  fileTree: string[]
): string {
  return `You are repairing a generated code change that failed validation.

USER REQUEST: ${summary}

VALIDATION ERRORS:
${validationErrors.map((error) => `- ${error}`).join("\n")}

REPOSITORY FILE TREE:
${fileTree.join("\n")}

ORIGINAL RELEVANT FILES:
${relevantFiles.map((file) => `--- ${file.path} ---\n${file.content}\n--- END ${file.path} ---`).join("\n\n")}

CURRENT INVALID CHANGES:
${currentChanges.map((change) => `--- ${change.filePath} ---\n${change.modifiedContent}\n--- END ${change.filePath} ---\nExplanation: ${change.explanation}`).join("\n\n")}

INSTRUCTIONS:
- Return a corrected complete change set that satisfies every validation error.
- Preserve useful parts of the current invalid changes when safe.
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

import type { RelevantFile } from "@mosaic/core";

export function buildGenerationPrompt(summary: string, relevantFiles: RelevantFile[], fileTree: string[]): string {
  return `You are a senior software engineer implementing a user-requested change in a codebase.

USER REQUEST: ${summary}

REPOSITORY FILE TREE:
${fileTree.join("\n")}

RELEVANT FILES:
${relevantFiles.map((file) => `--- ${file.path} ---\n${file.content}\n--- END ${file.path} ---`).join("\n\n")}

INSTRUCTIONS:
- Implement the requested change with minimal modifications.
- Preserve the existing code style, indentation, and conventions EXACTLY.
- Only modify files that need to change. Do not refactor unrelated code.
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

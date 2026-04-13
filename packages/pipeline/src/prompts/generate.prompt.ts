import type { RelevantFile } from "@feedbackbot/core";

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
- Do NOT add comments like '// Added by FeedbackBot' or '// Changed'.
- Your response must be valid JSON that parses with JSON.parse.
- Escape all quotes, backslashes, and newlines inside "modifiedContent" so it is a valid JSON string.
- If you genuinely cannot implement this change safely, return an empty array [].

Respond ONLY with a JSON array. No markdown, no explanation:
[
  {
    "filePath": "relative/path/to/file.ext",
    "modifiedContent": "...full file content with changes applied...",
    "explanation": "One sentence explaining what you changed and why."
  }
]`;
}

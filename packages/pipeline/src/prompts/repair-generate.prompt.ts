export function buildGenerationRepairPrompt(rawResponse: string): string {
  return `You repair malformed JSON produced by another model.

Your job:
- Return ONLY a valid JSON array.
- Preserve the intended content exactly.
- Do not summarize.
- Do not drop fields.
- Escape quotes, backslashes, and newlines inside JSON strings correctly.
- If the content is too incomplete to repair safely, return [].

Malformed response:
<RAW_RESPONSE>
${rawResponse}
</RAW_RESPONSE>`;
}

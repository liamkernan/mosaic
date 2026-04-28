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

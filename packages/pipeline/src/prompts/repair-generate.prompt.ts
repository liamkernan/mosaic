export function buildGenerationRepairPrompt(rawResponse: string): string {
  return `You repair malformed structured file-change output produced by another model.

Your job:
- Return ONLY a valid <changes>...</changes> payload.
- Preserve the intended content exactly.
- Do not summarize.
- Do not drop fields.
- Preserve either <change> full-file blocks or <edit> search/replace blocks.
- Put complete file contents and search/replace blocks inside <![CDATA[ ... ]]> blocks.
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
  const staticFrontendBytes = relevantFiles
    .filter((file) => /\.(?:html?|css|[cm]?js)$/i.test(file.path))
    .reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  const hasCompactedStaticFrontendContext = relevantFiles.some((file) => file.content.includes("MOSAIC CONTEXT NOTE"));
  const largeStaticFrontendSection = staticFrontendBytes > 45_000 || hasCompactedStaticFrontendContext
    ? "\nLARGE STATIC FRONTEND NOTE:\n- This appears to be a large static HTML/CSS/JS site. Prefer a minimal HTML hook/link/script insertion plus new scoped supplemental JS/CSS files when that can satisfy the requested workflow.\n- Do not duplicate large existing assets unless the existing file itself must change extensively.\n"
    : "";
  const oversizedPatchSection = validationErrors.some((error) => /too large|exceeds limit|total new code added/i.test(error))
    ? "\nOVERSIZED PATCH REPAIR MODE:\n- The current change set is too large to accept. Replace repeated or duplicated UI with one reusable component and compact data.\n- For repeated popups/modals, keep one shared overlay/dialog and fill its title, description, items, and reviews from JavaScript data or existing data attributes.\n- Preserve the requested user-visible behavior, but aggressively remove duplicated markup and verbose sample content.\n"
    : "";

  return `You are repairing a generated code change that failed validation.

USER REQUEST: ${summary}

VALIDATION ERRORS:
${validationErrors.map((error) => `- ${error}`).join("\n")}

REPOSITORY FILE TREE:
${fileTree.join("\n")}
${planSection}
${largeStaticFrontendSection}
${oversizedPatchSection}

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
- If validation says a new static asset is not linked, update the HTML to load that exact JS or CSS file; do not leave supplemental behavior/style files orphaned.
- If validation says a script queries missing HTML ids/selectors, either add those exact hooks to the HTML or update the script to target hooks that actually exist. Do not keep JavaScript selectors that match nothing.
- If validation says total new code is too large, reduce repeated markup/data first: use one reusable modal/dialog/overlay, compact JavaScript data, and shared selectors instead of duplicating UI blocks.
- If validation says modal/dialog/overlay behavior is missing, return script changes that wire every new trigger to the exact new modal/dialog/overlay ids/classes/data attributes. Do not return HTML/CSS-only repairs for interactive UI.
- Modal/dialog/overlay behavior must at minimum open on click, support keyboard activation for non-native triggers, close by close button/backdrop/Escape where applicable, and update aria-hidden or native dialog state consistently.
- Replace click-only div/article/section/card containers with native buttons or links where possible; otherwise add role, tabindex, and keyboard handling.
- Remove or wire any visible href="#" or javascript:void(0) links so every visible control performs the requested workflow.
- If HTML adds modal/dialog/overlay classes or hooks, include matching CSS selectors in the stylesheet in the same response.
- If JavaScript is needed for new interactive UI, include the matching script changes in the same response.
- Return ONLY the response format below. No markdown fences. No prose before or after.
- For existing files, prefer exact <edit> search/replace blocks when the repair is localized. Use <change> full-file blocks only when search/replace cannot express the repair safely or when creating a new file.
- Every <edit> search block must match the original file exactly once. Include enough surrounding context to make it unique.
- Put complete updated file contents or search/replace blocks inside CDATA.
- If you cannot repair safely, return exactly <changes></changes>.

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

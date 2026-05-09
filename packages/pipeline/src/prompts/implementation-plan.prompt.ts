import type { ClassifiedFeedback, RelevantFile } from "@mosaic/core";

export function buildImplementationPlanPrompt(
  feedback: ClassifiedFeedback,
  relevantFiles: RelevantFile[],
  fileTree: string[]
): string {
  return `You are planning a complete implementation for a moderate/high-complexity software change.

USER REQUEST:
${feedback.rawContent}

CLASSIFICATION:
- Category: ${feedback.category}
- Complexity: ${feedback.complexity}
- Summary: ${feedback.summary}

REPOSITORY FILE TREE:
${fileTree.join("\n")}

CURRENTLY LOADED FILES:
${relevantFiles.map((file) => `- ${file.path}: ${file.reason}`).join("\n")}

Your job is to identify every file surface needed for a complete user-visible solution in one PR.

Rules:
- Include markup/view files, stylesheets, scripts/state files, routing files, data/content files, tests, and config when they are needed.
- For clickable UI, modals, drawers, accordions, tabs, forms, filters, navigation, or routes, include both the UI surface and the behavior/state surface.
- For new content experiences, include the content/data source and the rendering behavior.
- Do not include unrelated files.
- Prefer existing app patterns and filenames from the repository tree.
- Return only JSON. No markdown fences.

JSON shape:
{
  "requiredFiles": [
    {
      "path": "relative/path.ext",
      "reason": "why this file is needed"
    }
  ],
  "implementationChecklist": [
    "specific behavior or acceptance criterion that must be true"
  ],
  "verificationChecklist": [
    "specific manual or automated check that would catch an incomplete implementation"
  ]
}`;
}

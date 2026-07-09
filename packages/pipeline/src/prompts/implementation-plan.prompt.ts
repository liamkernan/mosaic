import type { ClassifiedFeedback, RelevantFile } from "@mosaic/core";
import { formatPromptFileBlocksWithReasons, formatPromptFileTree, promptFilePaths } from "./context-budget.js";

const implementationPlanMaxFileTreePaths = 1_800;

export function buildImplementationPlanPrompt(
  feedback: ClassifiedFeedback,
  relevantFiles: RelevantFile[],
  fileTree: string[]
): string {
  const promptFileTree = formatPromptFileTree(fileTree, {
    maxPaths: implementationPlanMaxFileTreePaths,
    summary: feedback.summary,
    rawContent: feedback.rawContent,
    relevantPaths: promptFilePaths(relevantFiles)
  });

  return `You are planning a complete implementation for a moderate/high-complexity software change.

USER REQUEST:
${feedback.rawContent}

CLASSIFICATION:
- Category: ${feedback.category}
- Complexity: ${feedback.complexity}
- Summary: ${feedback.summary}

REPOSITORY FILE TREE:
${promptFileTree}

CURRENTLY LOADED FILES:
${formatPromptFileBlocksWithReasons(relevantFiles)}

Your job is to identify every file surface needed for a complete user-visible solution in one PR.

Rules:
- Treat repository issue files, README/docs, tests, and config as authoritative when they state expected behavior.
- Extract every explicit acceptance criterion from authoritative sources before deciding files.
- Translate loaded tests into acceptance criteria. Include asserted response fields, dictionary keys, status codes, returned values, side effects, and edge cases.
- If a source states a sequence, ordering, tie-breaker, fallback, validation rule, or exact field/key, preserve it exactly. Do not substitute a merely stable or plausible alternative.
- Include markup/view files, stylesheets, scripts/state files, routing files, data/content files, tests, and config when they are needed.
- Include tests when the repository has a relevant test pattern and the change affects behavior, especially sort/order/filter/ranking logic, persistence, validation, permissions, or API responses.
- Do not plan edits to existing reported/regression tests; treat them as immutable verification oracles. Plan an independent companion test in the repository's normal generated or non-reported test location for any missing edge case.
- For sort/order/filter/ranking bugs, verification must include adversarial cases for the primary condition and every stated tie-breaker.
- For dedupe/idempotency/retry bugs, acceptance criteria and verification must include both the duplicate/update path and the non-duplicate path where records should remain distinct.
- For API/HTTP endpoint requests, required files and checklist items must include the route/handler surface, backing service/data surface, a unit test of the backing behavior, and a handler test that exercises the public path without opening a real network listener.
- Tests must not introduce literal URLs, loopback IP addresses, wildcard hosts, or external network calls. Prefer repository-native in-process handler/request helpers.
- Extract exact safe test commands from issue files, README/docs, or package scripts when available. Use only test commands such as python unittest, pytest, npm test, pnpm test, or vitest; omit setup, server, curl, database mutation, deploy, or destructive commands.
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
  "acceptanceCriteria": [
    "explicit requirement copied or tightly paraphrased from repo docs/tests/user request"
  ],
  "implementationChecklist": [
    "specific behavior or acceptance criterion that must be true"
  ],
  "verificationChecklist": [
    "specific manual or automated check that would catch an incomplete implementation"
  ],
  "verificationCommands": [
    "exact safe automated test command from repo docs, or empty when none is available"
  ]
}`;
}

import { compactPromptFileTree } from "./context-budget.js";

const classificationMaxFileTreePaths = 1_200;

function formatClassificationFileTree(rawContent: string, fileTree: string[]): string {
  const compacted = compactPromptFileTree(fileTree, {
    maxPaths: classificationMaxFileTreePaths,
    rawContent
  });
  const note = compacted.omittedCount > 0
    ? `\n[MOSAIC CONTEXT NOTE: ${compacted.omittedCount} lower-relevance repository path(s) omitted from this classification prompt.]`
    : "";

  return `${compacted.paths.join("\n")}${note}`;
}

export function buildClassificationPrompt(
  rawContent: string,
  fileTree: string[],
): string {
  const promptFileTree = formatClassificationFileTree(rawContent, fileTree);

  return `You are a feedback classifier for a software repository. You will receive user feedback and a list of files in the repository.

Your job:
1. Determine the CATEGORY of this feedback: bug_report, feature_request, copy_change, ui_tweak, question, or other.
2. Estimate the COMPLEXITY of implementing this:
   - trivial: one isolated text, punctuation, or value correction in one location with no coordination or runtime behavior
   - simple: a bounded static change that coordinates a few locations, or a small localized behavior change
   - moderate: requires conditional, causal, interaction, or state-transition reasoning across components or modules, or changes persisted or sensitive behavior within one subsystem
   - complex: spans runtime layers such as UI, API, storage, and workers; changes architecture or schemas; or remains materially uncertain
3. Write a one-sentence SUMMARY of what the user is asking for.
4. List which FILES in the repository are most likely to need changes (max 5).
5. Rate your CONFIDENCE from 0 to 1 (decimal value).
6. Return ROUTING SIGNALS:
   - scope: localized for one isolated location; coordinated for the same bounded static change in a few locations; multi-component for logic across components/modules in one subsystem; cross-layer for behavior spanning UI/API/storage/workers or architecture
   - runtimeBehavior: true for conditionals, state transitions, events, data selection, or control behavior; false for copy, style, or metadata only
   - persistentData: true if records, schemas, migrations, or durable writes can change
   - securitySensitive: true for authentication, authorization, secrets, permissions, containment, or destructive operations
   - requiresHumanReview: true for financial, fulfillment, account-lifecycle, security, persisted business behavior, or materially ambiguous/high-impact work; false for bounded copy, presentation, accessibility metadata, or local UI-state fixes

Respond ONLY with a JSON object. No markdown, no explanation, no preamble.

{
  "category": "...",
  "complexity": "...",
  "summary": "...",
  "relevantFiles": ["..."],
  "confidence": 0.0,
  "routingSignals": {
    "scope": "localized | coordinated | multi-component | cross-layer",
    "runtimeBehavior": false,
    "persistentData": false,
    "securitySensitive": false,
    "requiresHumanReview": false
  }
}

The repository contains these files:
<FILE_TREE>
${promptFileTree}
</FILE_TREE>

The user feedback is:
<FEEDBACK>
${rawContent}
</FEEDBACK>`;
}

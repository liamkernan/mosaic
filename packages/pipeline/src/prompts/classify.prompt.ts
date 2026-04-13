export function buildClassificationPrompt(
  rawContent: string,
  fileTree: string[],
): string {
  return `You are a feedback classifier for a software repository. You will receive user feedback and a list of files in the repository.

Your job:
1. Determine the CATEGORY of this feedback: bug_report, feature_request, copy_change, ui_tweak, question, or other.
2. Estimate the COMPLEXITY of implementing this:
   - trivial: typo fix, single-word change, obvious one-line fix
   - simple: small change to 1-2 files, like updating text, adjusting a CSS value, fixing a broken link
   - moderate: requires understanding component logic, touching 2-4 files, or adding a small feature
   - complex: architectural change, new feature requiring multiple components, database changes, or anything you're unsure about
3. Write a one-sentence SUMMARY of what the user is asking for.
4. List which FILES in the repository are most likely to need changes (max 5).
5. Rate your CONFIDENCE from 0 to 1 (decimal value).

Respond ONLY with a JSON object. No markdown, no explanation, no preamble.

{
  "category": "...",
  "complexity": "...",
  "summary": "...",
  "relevantFiles": ["..."],
  "confidence": 0.0
}

The repository contains these files:
<FILE_TREE>
${fileTree.join("\n")}
</FILE_TREE>

The user feedback is:
<FEEDBACK>
${rawContent}
</FEEDBACK>`;
}

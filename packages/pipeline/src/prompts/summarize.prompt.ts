import type { ClassifiedFeedback, GeneratedChange } from "@mosaic/core";

export function buildSummaryPrompt(feedback: ClassifiedFeedback, changes: GeneratedChange[]): string {
  return `Summarize the following automated code changes for a pull request description.

Feedback summary: ${feedback.summary}
Category: ${feedback.category}
Complexity: ${feedback.complexity}

Changes:
${changes.map((change) => `- ${change.filePath}: ${change.explanation}`).join("\n")}

Return 2-3 concise markdown bullet points.`;
}

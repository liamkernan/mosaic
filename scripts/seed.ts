import { ulid } from "ulid";

import type { FeedbackItem, FeedbackSource } from "../packages/core/src/types.js";
import { enqueueFeedback } from "../packages/intake/src/queue.js";

const sources: FeedbackSource[] = ["web_form", "email", "github_issue", "github_comment", "discord", "api"];

const samples = [
  "Fix the typo on the pricing page CTA.",
  "The signup link on the home page is broken.",
  "Add a tooltip to explain the billing interval selector.",
  "Please make the hero button text more direct.",
  "The dashboard crashes when no projects exist.",
  "Can you add dark mode?",
  "The footer copyright year is outdated.",
  "It would help to support keyboard shortcuts in the editor.",
  "The Discord invite link seems invalid.",
  "The onboarding copy should mention SSO support."
];

async function main(): Promise<void> {
  const repoFullName = process.argv[2] ?? "owner/repo";

  const items: FeedbackItem[] = samples.map((rawContent, index) => ({
    id: ulid(),
    source: sources[index % sources.length],
    rawContent,
    senderIdentifier: `seed-user-${index + 1}`,
    repoFullName,
    receivedAt: new Date(),
    metadata: {
      seeded: true
    }
  }));

  await Promise.all(items.map((item) => enqueueFeedback(item)));
  process.stdout.write(`Seeded ${items.length} feedback items for ${repoFullName}.\n`);
}

void main();

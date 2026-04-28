import { type ClassifiedFeedback, type RepoContext } from "@feedbackbot/core";
import { getOctokit } from "@feedbackbot/github-app";

import {
  buildStagedIssueMetadata,
  buildStagedIssueMetadataComment,
  getIssueModeLabel,
  getPromotionDescription,
  STAGED_ISSUE_LABEL,
  type ModerateIssueMode
} from "./staged-issues.js";

interface IssueCreationOptions {
  reason: string;
  issueMode?: ModerateIssueMode;
}

export class IssueCreator {
  async createIssue(
    classifiedFeedback: ClassifiedFeedback,
    repoContext: RepoContext,
    options: IssueCreationOptions
  ): Promise<number> {
    const octokit = await getOctokit(repoContext.installationId);
    const [owner, repo] = classifiedFeedback.repoFullName.split("/");
    const labels = ["feedbackbot", "needs-human", classifiedFeedback.category];
    const promotionSection = options.issueMode
      ? `### Promotion Path
This issue is classified as **${options.issueMode}**.
${getPromotionDescription(options.issueMode)}
`
      : "";
    const stagedMetadata = options.issueMode
      ? buildStagedIssueMetadataComment(buildStagedIssueMetadata(classifiedFeedback, options.issueMode))
      : "";

    if (options.issueMode) {
      labels.push(STAGED_ISSUE_LABEL, getIssueModeLabel(options.issueMode));
    }

    const issue = await octokit.rest.issues.create({
      owner,
      repo,
      title: `[Feedback] ${classifiedFeedback.summary}`.slice(0, 120),
      body: `## User Feedback

**Source:** ${classifiedFeedback.source}
**Category:** ${classifiedFeedback.category}
**Complexity:** ${classifiedFeedback.complexity}

### Feedback Content
> ${classifiedFeedback.rawContent.slice(0, 1_000).replace(/\n/g, "\n> ")}

### Why This Wasn't Auto-Implemented
${options.reason}

${promotionSection}
---
*Triaged by [FeedbackBot](https://github.com/YOUR_USERNAME/feedbackbot).*
${stagedMetadata}`.trim(),
      labels
    });

    return issue.data.number;
  }
}

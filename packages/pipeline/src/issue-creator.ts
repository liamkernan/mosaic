import { type ClassifiedFeedback, type RepoContext } from "@mosaic/core";
import { getOctokit } from "@mosaic/github-app";

import {
  buildStagedIssueMetadata,
  buildStagedIssueMetadataComment,
  getIssueModeLabel,
  getPromotionDescription,
  STAGED_ISSUE_LABEL,
  type StagedIssueMode,
} from "./staged-issues.js";

interface IssueCreationOptions {
  reason: string;
  issueMode?: StagedIssueMode;
}

export class IssueCreator {
  async createIssue(
    classifiedFeedback: ClassifiedFeedback,
    repoContext: RepoContext,
    options: IssueCreationOptions,
  ): Promise<number> {
    const octokit = await getOctokit(repoContext.installationId);
    const [owner, repo] = classifiedFeedback.repoFullName.split("/");
    const labels = ["mosaic", "needs-human", classifiedFeedback.category];
    const promotionSection = options.issueMode
      ? `### Promotion Path
This issue is classified as **${options.issueMode}**.
${getPromotionDescription(options.issueMode)}
`
      : "";
    const truncationNotice = classifiedFeedback.contentTruncation
      ? `> **Incomplete intake content:** Mosaic retained ${classifiedFeedback.contentTruncation.retainedLength.toLocaleString("en-US")} of ${classifiedFeedback.contentTruncation.originalLength.toLocaleString("en-US")} characters. Please review the original source before implementation.\n>\n`
      : "";
    const title = `[Feedback] ${classifiedFeedback.summary}`.slice(0, 120);
    const visibleBody = `## User Feedback

**Source:** ${classifiedFeedback.source}
**Category:** ${classifiedFeedback.category}
**Complexity:** ${classifiedFeedback.complexity}

### Feedback Content
${truncationNotice}> ${classifiedFeedback.rawContent.slice(0, 1_000).replace(/\n/g, "\n> ")}

### Why This Wasn't Auto-Implemented
${options.reason}

${promotionSection}
---
*Triaged by [Mosaic](https://github.com/liamkernan/mosaic).*`.trim();
    const stagedMetadata = options.issueMode
      ? buildStagedIssueMetadataComment(
          buildStagedIssueMetadata(classifiedFeedback, options.issueMode, {
            title,
            body: visibleBody
          }),
        )
      : "";
    const body = stagedMetadata ? `${visibleBody}\n${stagedMetadata}` : visibleBody;

    if (options.issueMode) {
      labels.push(STAGED_ISSUE_LABEL, getIssueModeLabel(options.issueMode));
    }

    const issue = await octokit.rest.issues.create({
      owner,
      repo,
      title,
      body,
      labels,
    });

    return issue.data.number;
  }
}

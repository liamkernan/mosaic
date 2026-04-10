import { type ClassifiedFeedback, type RepoContext } from "@feedbackbot/core";
import { getOctokit } from "@feedbackbot/github-app";

export class IssueCreator {
  async createIssue(classifiedFeedback: ClassifiedFeedback, repoContext: RepoContext, reason: string): Promise<number> {
    const octokit = await getOctokit(repoContext.installationId);
    const [owner, repo] = classifiedFeedback.repoFullName.split("/");

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
${reason}

---
*Triaged by [FeedbackBot](https://github.com/YOUR_USERNAME/feedbackbot).*`,
      labels: ["feedbackbot", "needs-human", classifiedFeedback.category]
    });

    return issue.data.number;
  }
}

import { getEnv, logger } from "@mosaic/core";
import type { Context, Probot } from "probot";

const GITHUB_FORWARD_URL = `http://127.0.0.1:${getEnv().PORT}/webhook/github`;

async function repoAllowsGithubIntake(context: Context<"issues.opened" | "issue_comment.created">): Promise<boolean> {
  const { owner, repo } = context.repo();
  const configCandidates = ["mosaic.config.yml", "feedbackbot.config.yml"];

  for (const configPath of configCandidates) {
    try {
      const file = await context.octokit.rest.repos.getContent({
        owner,
        repo,
        path: configPath
      });

      if (!("content" in file.data)) {
        continue;
      }

      const decoded = Buffer.from(file.data.content, "base64").toString("utf8");
      if (/\bgithub_issue\b|\bgithub_comment\b/.test(decoded)) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

async function forwardWebhookPayload(payload: unknown): Promise<void> {
  const response = await fetch(GITHUB_FORWARD_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Failed to forward GitHub webhook: ${response.status}`);
  }
}

export function bodyContainsTrigger(context: Context<"issues.opened" | "issue_comment.created">): boolean {
  const triggerPhrase = getEnv().MOSAIC_TRIGGER_PHRASE ?? "@mosaic";
  const payload = context.payload;
  const body = "comment" in payload ? payload.comment.body : payload.issue.body;
  return typeof body === "string" && body.includes(triggerPhrase);
}

export default function app(appInstance: Probot): void {
  appInstance.on("installation.created", async (context) => {
    logger.info({ installationId: context.payload.installation?.id }, "GitHub App installation created");
  });

  appInstance.on(["issues.opened", "issue_comment.created"], async (context) => {
    const shouldForward = bodyContainsTrigger(context) || (await repoAllowsGithubIntake(context));
    if (!shouldForward) {
      return;
    }

    await forwardWebhookPayload(context.payload);
    logger.info({ event: context.name, repo: context.payload.repository.full_name }, "Forwarded GitHub feedback");
  });
}

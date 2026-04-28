import { getEnv, logger } from "@mosaic/core";
import type { Context, Probot } from "probot";

const GITHUB_FORWARD_URL = `http://127.0.0.1:${getEnv().PORT}/webhook/github`;

async function repoAllowsGithubIntake(context: Context<"issues.opened" | "issue_comment.created">): Promise<boolean> {
  const { owner, repo } = context.repo();

  try {
    const file = await context.octokit.rest.repos.getContent({
      owner,
      repo,
      path: "mosaic.config.yml"
    });

    if (!("content" in file.data)) {
      return false;
    }

    const decoded = Buffer.from(file.data.content, "base64").toString("utf8");
    return /\bgithub_issue\b|\bgithub_comment\b/.test(decoded);
  } catch {
    return false;
  }
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

function bodyContainsTrigger(context: Context<"issues.opened" | "issue_comment.created">): boolean {
  const triggerPhrase = getEnv().MOSAIC_TRIGGER_PHRASE;
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

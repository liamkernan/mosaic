import { App } from "@slack/bolt";
import { assertRequiredEnv, getEnv, logger } from "@mosaic/core";

import { parseSlackRepoMappings, resolveSlackRepo } from "./routing.js";

interface SlackIntakeBody {
  message: string;
  repoFullName: string;
  username: string;
  userId: string;
  channelId: string;
  teamId?: string;
  messageTs?: string;
  threadTs?: string;
}

interface SlackAppMentionEvent {
  type: "app_mention";
  user: string;
  text?: string;
  channel: string;
  ts?: string;
  team?: string;
  thread_ts?: string;
}

function buildIntakeUrl(): string {
  const env = getEnv();
  return env.SLACK_INTAKE_URL ?? `http://127.0.0.1:${env.PORT}/webhook/slack`;
}

export function stripSlackBotMention(content: string, botUserId: string): string {
  return content
    .replace(new RegExp(`<@${botUserId}>`, "g"), "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildFeedbackMessage(event: SlackAppMentionEvent, botUserId: string): string {
  return stripSlackBotMention(event.text ?? "", botUserId);
}

async function forwardToIntake(body: SlackIntakeBody): Promise<string> {
  const env = getEnv();
  const response = await fetch(buildIntakeUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mosaic-intake-secret": env.MOSAIC_INTAKE_SHARED_SECRET!
    },
    body: JSON.stringify(body)
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`Slack intake rejected message with ${response.status}: ${responseBody}`);
  }

  const parsed = JSON.parse(responseBody) as { feedbackId?: string };
  return parsed.feedbackId ?? "unknown";
}

export async function startSlackBot(): Promise<App> {
  assertRequiredEnv("SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "MOSAIC_INTAKE_SHARED_SECRET");

  const env = getEnv();
  const app = new App({
    token: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    socketMode: true
  });
  const auth = await app.client.auth.test();
  const botUserId = auth.user_id;
  if (!botUserId) {
    throw new Error("Slack auth.test did not return a bot user id");
  }

  const mappings = parseSlackRepoMappings(env.SLACK_REPO_MAPPINGS);

  app.event("app_mention", async ({ event, client, context }) => {
    await handleAppMention({
      botUserId,
      client,
      contextTeamId: context.teamId,
      event: event as SlackAppMentionEvent,
      mappings
    });
  });

  await app.start();
  logger.info({ botUserId }, "Slack bot started");
  return app;
}

async function handleAppMention({
  botUserId,
  client,
  contextTeamId,
  event,
  mappings
}: {
  botUserId: string;
  client: App["client"];
  contextTeamId?: string;
  event: SlackAppMentionEvent;
  mappings: ReturnType<typeof parseSlackRepoMappings>;
}): Promise<void> {
  const feedbackMessage = buildFeedbackMessage(event, botUserId);
  const threadTs = event.thread_ts ?? event.ts;
  if (!feedbackMessage) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: "Mention me with the feedback text you want sent to GitHub."
    });
    return;
  }

  const teamId = event.team ?? contextTeamId;
  const repoFullName = resolveSlackRepo(
    {
      teamId,
      channelId: event.channel
    },
    mappings,
    getEnv().SLACK_DEFAULT_REPO
  );

  try {
    const feedbackId = await forwardToIntake({
      repoFullName,
      message: feedbackMessage,
      username: event.user,
      userId: event.user,
      channelId: event.channel,
      teamId,
      messageTs: event.ts,
      threadTs
    });

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: `Queued feedback for ${repoFullName}. Feedback ID: ${feedbackId}`
    });
  } catch (error) {
    logger.error({ err: error, channelId: event.channel, teamId }, "Failed to handle Slack feedback");
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: "I could not queue that feedback. Check the Mosaic logs for details."
    });
    throw error;
  }
}

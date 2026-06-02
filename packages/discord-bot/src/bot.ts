import { Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";
import { assertRequiredEnv, getEnv, logger } from "@mosaic/core";

import { parseDiscordRepoMappings, resolveDiscordRepo } from "./routing.js";

interface DiscordIntakeBody {
  message: string;
  repoFullName: string;
  username: string;
  userId: string;
  channelId: string;
  guildId?: string;
}

function buildIntakeUrl(): string {
  const env = getEnv();
  return env.DISCORD_INTAKE_URL ?? `http://127.0.0.1:${env.PORT}/webhook/discord`;
}

export function stripBotMention(content: string, botUserId: string): string {
  return content
    .replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
    .replace(/\s+/g, " ")
    .trim();
}

function messageIncludesBotMention(message: Message, botUserId: string): boolean {
  return message.mentions.users.has(botUserId) || new RegExp(`<@!?${botUserId}>`).test(message.content);
}

function buildFeedbackMessage(message: Message, botUserId: string): string {
  const content = stripBotMention(message.content, botUserId);
  const attachmentUrls = [...message.attachments.values()].map((attachment) => attachment.url);

  if (attachmentUrls.length === 0) {
    return content;
  }

  return `${content}\n\nAttachments:\n${attachmentUrls.join("\n")}`.trim();
}

async function forwardToIntake(body: DiscordIntakeBody): Promise<string> {
  const response = await fetch(buildIntakeUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`Discord intake rejected message with ${response.status}: ${responseBody}`);
  }

  const parsed = JSON.parse(responseBody) as { feedbackId?: string };
  return parsed.feedbackId ?? "unknown";
}

export async function startDiscordBot(): Promise<Client> {
  assertRequiredEnv("DISCORD_BOT_TOKEN");

  const env = getEnv();
  const mappings = parseDiscordRepoMappings(env.DISCORD_REPO_MAPPINGS);
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages];
  if (env.DISCORD_ENABLE_MESSAGE_CONTENT_INTENT) {
    intents.push(GatewayIntentBits.MessageContent);
  }

  const client = new Client({
    intents,
    partials: [Partials.Channel]
  });

  client.once(Events.ClientReady, (readyClient) => {
    logger.info({ user: readyClient.user.tag }, "Discord bot started");
  });

  client.on(Events.MessageCreate, (message) => {
    void handleMentionMessage(message, client, mappings).catch(async (error) => {
      logger.error({ err: error, channelId: message.channelId, guildId: message.guildId }, "Failed to handle Discord feedback");
      await message.reply("I could not queue that feedback. Check the Mosaic logs for details.").catch(() => undefined);
    });
  });

  await client.login(env.DISCORD_BOT_TOKEN);
  return client;
}

async function handleMentionMessage(
  message: Message,
  client: Client,
  mappings: ReturnType<typeof parseDiscordRepoMappings>
): Promise<void> {
  const botUserId = client.user?.id;
  if (!botUserId || message.author.bot || !messageIncludesBotMention(message, botUserId)) {
    return;
  }

  const feedbackMessage = buildFeedbackMessage(message, botUserId);
  if (!feedbackMessage) {
    await message.reply("Mention me with the feedback text you want sent to GitHub.");
    return;
  }

  const repoFullName = resolveDiscordRepo(
    {
      guildId: message.guildId,
      channelId: message.channelId
    },
    mappings,
    getEnv().DISCORD_DEFAULT_REPO
  );

  const feedbackId = await forwardToIntake({
    repoFullName,
    message: feedbackMessage,
    username: message.author.tag,
    userId: message.author.id,
    channelId: message.channelId,
    guildId: message.guildId ?? undefined
  });

  await message.reply(`Queued feedback for ${repoFullName}. Feedback ID: ${feedbackId}`);
}

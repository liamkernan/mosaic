import type { FastifyReply, FastifyRequest } from "fastify";

import { normalize } from "../normalizer.js";
import { enqueueFeedback } from "../queue.js";

interface DiscordWebhookBody {
  message: string;
  repoFullName: string;
  username?: string;
  userId?: string;
  channelId?: string;
  guildId?: string;
}

export async function handleDiscordWebhook(
  request: FastifyRequest<{ Body: DiscordWebhookBody }>,
  reply: FastifyReply
): Promise<void> {
  const feedback = normalize(
    {
      message: request.body.message,
      repoFullName: request.body.repoFullName,
      username: request.body.username,
      userId: request.body.userId,
      metadata: {
        channelId: request.body.channelId,
        guildId: request.body.guildId
      }
    },
    "discord"
  );

  await enqueueFeedback(feedback);
  reply.code(202).send({ accepted: true, feedbackId: feedback.id });
}

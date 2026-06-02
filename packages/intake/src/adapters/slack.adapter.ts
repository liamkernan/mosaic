import type { FastifyReply, FastifyRequest } from "fastify";

import { normalize } from "../normalizer.js";
import { enqueueFeedback } from "../queue.js";

interface SlackWebhookBody {
  message: string;
  repoFullName: string;
  username?: string;
  userId?: string;
  channelId?: string;
  teamId?: string;
  messageTs?: string;
  threadTs?: string;
}

export async function handleSlackWebhook(
  request: FastifyRequest<{ Body: SlackWebhookBody }>,
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
        teamId: request.body.teamId,
        messageTs: request.body.messageTs,
        threadTs: request.body.threadTs
      }
    },
    "slack"
  );

  await enqueueFeedback(feedback);
  reply.code(202).send({ accepted: true, feedbackId: feedback.id });
}

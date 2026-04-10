import type { FastifyReply, FastifyRequest } from "fastify";

import { normalize } from "../normalizer.js";
import { enqueueFeedback } from "../queue.js";

export interface FormWebhookBody {
  message: string;
  repoFullName: string;
  senderEmail?: string;
}

export async function handleFormWebhook(
  request: FastifyRequest<{ Body: FormWebhookBody }>,
  reply: FastifyReply
): Promise<void> {
  const feedback = normalize(
    {
      message: request.body.message,
      repoFullName: request.body.repoFullName,
      senderEmail: request.body.senderEmail,
      metadata: {
        ip: request.ip,
        headers: request.headers
      }
    },
    "web_form"
  );

  await enqueueFeedback(feedback);
  reply.code(202).send({ accepted: true, feedbackId: feedback.id });
}

import type { FastifyReply, FastifyRequest } from "fastify";
import { ValidationError } from "@mosaic/core";

import {
  assertEmbedBotFields,
  assertEmbedOriginAllowed,
  buildAnonymousSenderIdentifier,
  findFormEmbedConfig,
  renderEmbedScript
} from "../form-embeds.js";
import { assertTrustedIntakeRequest } from "../intake-auth.js";
import { normalize } from "../normalizer.js";
import { enqueueFeedback } from "../queue.js";

export interface FormWebhookBody {
  message: string;
  repoFullName: string;
  senderEmail?: string;
}

export interface EmbeddedFormWebhookBody {
  embedKey: string;
  message: string;
  senderEmail?: string;
  honeypot?: string;
  loadedAt?: number;
  pageUrl?: string;
}

export async function handleFormWebhook(
  request: FastifyRequest<{ Body: FormWebhookBody }>,
  reply: FastifyReply
): Promise<void> {
  assertTrustedIntakeRequest(request);

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

export async function handleEmbeddedFormWebhook(
  request: FastifyRequest<{ Body: EmbeddedFormWebhookBody }>,
  reply: FastifyReply
): Promise<void> {
  const config = findFormEmbedConfig(request.body.embedKey);
  assertEmbedOriginAllowed(request.headers.origin, config);
  assertEmbedBotFields(
    {
      honeypot: request.body.honeypot,
      loadedAt: request.body.loadedAt
    },
    Date.now(),
    config.minSubmitMs
  );

  const senderEmail = request.body.senderEmail?.trim();
  if (config.requireEmail && !senderEmail) {
    throw new ValidationError("senderEmail is required for this feedback form");
  }

  const feedback = normalize(
    {
      message: request.body.message,
      repoFullName: config.repoFullName,
      senderEmail,
      senderIdentifier: senderEmail ?? buildAnonymousSenderIdentifier(config.embedKey, request.ip),
      metadata: {
        ip: request.ip,
        origin: request.headers.origin,
        pageUrl: request.body.pageUrl,
        embedKey: config.embedKey,
        headers: request.headers
      }
    },
    "web_form"
  );

  await enqueueFeedback(feedback);
  reply.code(202).send({ accepted: true, feedbackId: feedback.id });
}

export async function handleEmbedScript(
  request: FastifyRequest<{ Params: { embedKey: string } }>,
  reply: FastifyReply
): Promise<void> {
  const config = findFormEmbedConfig(request.params.embedKey);

  reply
    .header("content-type", "application/javascript; charset=utf-8")
    .header("cache-control", "public, max-age=300")
    .send(renderEmbedScript(config));
}

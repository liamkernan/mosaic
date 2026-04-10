import Fastify from "fastify";
import cors from "@fastify/cors";
import { AbuseDetectedError, getEnv, logger, RateLimitError, ValidationError } from "@feedbackbot/core";

import { handleDiscordWebhook } from "./adapters/discord.adapter.js";
import { EmailListener } from "./adapters/email.adapter.js";
import { handleGithubWebhook } from "./adapters/github.adapter.js";
import { handleFormWebhook } from "./adapters/webhook.adapter.js";

const formBodySchema = {
  type: "object",
  required: ["message", "repoFullName"],
  properties: {
    message: { type: "string", minLength: 1 },
    repoFullName: { type: "string", minLength: 3 },
    senderEmail: { type: "string" }
  }
} as const;

const githubBodySchema = {
  type: "object",
  properties: {
    action: { type: "string" },
    repository: {
      type: "object",
      properties: {
        full_name: { type: "string" }
      }
    }
  }
} as const;

const discordBodySchema = {
  type: "object",
  required: ["message", "repoFullName"],
  properties: {
    message: { type: "string", minLength: 1 },
    repoFullName: { type: "string", minLength: 3 },
    username: { type: "string" },
    userId: { type: "string" },
    channelId: { type: "string" },
    guildId: { type: "string" }
  }
} as const;

export async function createIntakeServer() {
  const server = Fastify({
    logger: false
  });
  const emailListener = new EmailListener();

  await server.register(cors);

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ValidationError) {
      reply.code(400).send({ error: error.code, message: error.message });
      return;
    }

    if (error instanceof AbuseDetectedError) {
      reply.code(403).send({ error: error.code, message: error.message });
      return;
    }

    if (error instanceof RateLimitError) {
      reply.code(429).send({ error: error.code, message: error.message });
      return;
    }

    const message = error instanceof Error ? error.message : "Unknown server error";
    reply.code(500).send({ error: "INTERNAL_ERROR", message });
  });

  server.get("/health", async () => ({ ok: true }));
  server.post("/webhook/form", { schema: { body: formBodySchema } }, handleFormWebhook);
  server.post("/webhook/github", { schema: { body: githubBodySchema } }, handleGithubWebhook);
  server.post("/webhook/discord", { schema: { body: discordBodySchema } }, handleDiscordWebhook);

  server.addHook("onClose", async () => {
    await emailListener.stop();
  });

  return {
    server,
    emailListener
  };
}

export async function startIntakeServer(): Promise<void> {
  const { server, emailListener } = await createIntakeServer();
  await server.listen({ port: getEnv().PORT, host: "0.0.0.0" });
  await emailListener.start();
  logger.info({ port: getEnv().PORT }, "Intake server started");
}

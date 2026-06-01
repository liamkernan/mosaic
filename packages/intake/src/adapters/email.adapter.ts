import { Buffer } from "node:buffer";

import { ConfigError, getEnv, logger, repoFullNamePattern, type AppEnv } from "@mosaic/core";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

import { normalize } from "../normalizer.js";
import { enqueueFeedback } from "../queue.js";

export interface ParsedFeedbackEmail {
  subject: string;
  from: string;
  body: string;
}

export async function parseFeedbackEmail(raw: Buffer | string): Promise<ParsedFeedbackEmail> {
  const parsed = await simpleParser(raw);
  const subject = parsed.subject?.trim() || "Feedback submission";
  const htmlBody = typeof parsed.html === "string" ? parsed.html : "";
  const body = (parsed.text?.trim() || htmlBody.trim()).trim();

  return {
    subject,
    from: parsed.from?.text.trim() || "unknown",
    body
  };
}

export interface EmailMailboxConfig {
  repoFullName: string;
  host: string;
  port: number;
  user: string;
  pass: string;
  address: string;
  mailbox: string;
  secure: boolean;
}

type EmailEnv = Partial<Pick<
  AppEnv,
  | "EMAIL_MAILBOXES"
  | "EMAIL_IMAP_HOST"
  | "EMAIL_IMAP_PORT"
  | "EMAIL_IMAP_USER"
  | "EMAIL_IMAP_PASS"
  | "EMAIL_IMAP_MAILBOX"
  | "EMAIL_REPO_FULL_NAME"
>>;

function requireString(record: Record<string, unknown>, key: string, index: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`EMAIL_MAILBOXES[${index}].${key} must be a non-empty string`);
  }

  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseMailboxRecord(record: unknown, index: number): EmailMailboxConfig {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new ConfigError(`EMAIL_MAILBOXES[${index}] must be an object`);
  }

  const mailbox = record as Record<string, unknown>;
  const repoFullName = requireString(mailbox, "repoFullName", index);
  if (!repoFullNamePattern.test(repoFullName)) {
    throw new ConfigError(`EMAIL_MAILBOXES[${index}].repoFullName must be owner/repo`);
  }

  const port = mailbox.port === undefined ? 993 : Number(mailbox.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new ConfigError(`EMAIL_MAILBOXES[${index}].port must be a positive integer`);
  }

  const secure = mailbox.secure === undefined ? true : mailbox.secure;
  if (typeof secure !== "boolean") {
    throw new ConfigError(`EMAIL_MAILBOXES[${index}].secure must be a boolean`);
  }

  const user = requireString(mailbox, "user", index);

  return {
    repoFullName,
    host: requireString(mailbox, "host", index),
    port,
    user,
    pass: requireString(mailbox, "pass", index),
    address: optionalString(mailbox, "address") ?? user,
    mailbox: optionalString(mailbox, "mailbox") ?? "INBOX",
    secure
  };
}

export function getConfiguredEmailMailboxes(env: EmailEnv = getEnv()): EmailMailboxConfig[] {
  if (env.EMAIL_MAILBOXES) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.EMAIL_MAILBOXES);
    } catch {
      throw new ConfigError("EMAIL_MAILBOXES must be valid JSON");
    }

    if (!Array.isArray(parsed)) {
      throw new ConfigError("EMAIL_MAILBOXES must be a JSON array");
    }

    return parsed.map((record, index) => parseMailboxRecord(record, index));
  }

  const hasSingleMailboxSettings = Boolean(env.EMAIL_IMAP_HOST || env.EMAIL_IMAP_USER || env.EMAIL_IMAP_PASS || env.EMAIL_REPO_FULL_NAME);
  if (!hasSingleMailboxSettings) {
    return [];
  }

  if (!env.EMAIL_IMAP_HOST || !env.EMAIL_IMAP_USER || !env.EMAIL_IMAP_PASS || !env.EMAIL_REPO_FULL_NAME) {
    throw new ConfigError("EMAIL_IMAP_HOST, EMAIL_IMAP_USER, EMAIL_IMAP_PASS, and EMAIL_REPO_FULL_NAME are required for single-mailbox email intake");
  }

  return [
    parseMailboxRecord(
      {
        repoFullName: env.EMAIL_REPO_FULL_NAME,
        host: env.EMAIL_IMAP_HOST,
        port: env.EMAIL_IMAP_PORT,
        user: env.EMAIL_IMAP_USER,
        pass: env.EMAIL_IMAP_PASS,
        address: env.EMAIL_IMAP_USER,
        mailbox: env.EMAIL_IMAP_MAILBOX
      },
      0
    )
  ];
}

export class EmailListener {
  private readonly mailboxes: Array<{ config: EmailMailboxConfig; client: ImapFlow }>;
  private interval?: NodeJS.Timeout;

  constructor(mailboxes = getConfiguredEmailMailboxes()) {
    this.mailboxes = mailboxes.map((config) => ({
      config,
      client: new ImapFlow({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: {
          user: config.user,
          pass: config.pass
        }
      })
    }));
  }

  async start(): Promise<void> {
    const env = getEnv();
    if (this.mailboxes.length === 0) {
      logger.info("Email intake disabled because no mailboxes are configured");
      return;
    }

    for (const mailbox of this.mailboxes) {
      await mailbox.client.connect();
      await mailbox.client.mailboxOpen(mailbox.config.mailbox);
    }

    await this.pollOnce();
    this.interval = setInterval(() => {
      void this.pollOnce();
    }, env.EMAIL_POLL_INTERVAL_MS);
    logger.info({ mailboxCount: this.mailboxes.length }, "Email listener started");
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }

    for (const mailbox of this.mailboxes) {
      if (mailbox.client.usable) {
        await mailbox.client.logout();
      }
    }
  }

  async pollOnce(): Promise<void> {
    for (const mailbox of this.mailboxes) {
      await this.pollMailbox(mailbox.client, mailbox.config);
    }
  }

  private async pollMailbox(client: ImapFlow, config: EmailMailboxConfig): Promise<void> {
    if (!client.usable) {
      return;
    }

    for await (const message of client.fetch("1:*", {
      uid: true,
      flags: true,
      source: true
    })) {
      if (message.flags?.has("\\Seen")) {
        continue;
      }

      const parsedEmail = await parseFeedbackEmail(Buffer.from(message.source ?? ""));
      const { subject, from, body } = parsedEmail;

      const feedback = normalize(
        {
          subject,
          rawContent: body,
          senderEmail: from,
          repoFullName: config.repoFullName,
          metadata: {
            uid: message.uid,
            mailbox: config.address
          }
        },
        "email"
      );

      await enqueueFeedback(feedback);
      await client.messageFlagsAdd(message.uid.toString(), ["\\Seen"]);
    }
  }
}

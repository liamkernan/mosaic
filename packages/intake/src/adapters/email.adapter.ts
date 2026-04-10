import { Buffer } from "node:buffer";

import { getEnv, logger } from "@feedbackbot/core";
import { ImapFlow } from "imapflow";

import { normalize } from "../normalizer.js";
import { enqueueFeedback } from "../queue.js";

function parseHeader(raw: string, name: string): string | undefined {
  const match = raw.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim();
}

function extractBody(raw: string): string {
  const sections = raw.split(/\r?\n\r?\n/);
  return sections.slice(1).join("\n\n").trim();
}

function getRepoFromSubject(subject: string): string | undefined {
  return subject.match(/\[repo:([^\]]+)\]/i)?.[1]?.trim();
}

export class EmailListener {
  private readonly client: ImapFlow;
  private interval?: NodeJS.Timeout;

  constructor() {
    const env = getEnv();
    this.client = new ImapFlow({
      host: env.EMAIL_IMAP_HOST ?? "",
      port: env.EMAIL_IMAP_PORT,
      secure: true,
      auth: {
        user: env.EMAIL_IMAP_USER ?? "",
        pass: env.EMAIL_IMAP_PASS ?? ""
      }
    });
  }

  async start(): Promise<void> {
    const env = getEnv();
    if (!env.EMAIL_IMAP_HOST || !env.EMAIL_IMAP_USER || !env.EMAIL_IMAP_PASS) {
      logger.info("Email intake disabled because IMAP settings are incomplete");
      return;
    }

    await this.client.connect();
    await this.client.mailboxOpen("INBOX");
    await this.pollOnce();
    this.interval = setInterval(() => {
      void this.pollOnce();
    }, env.EMAIL_POLL_INTERVAL_MS);
    logger.info("Email listener started");
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }

    if (this.client.usable) {
      await this.client.logout();
    }
  }

  async pollOnce(): Promise<void> {
    if (!this.client.usable) {
      return;
    }

    for await (const message of this.client.fetch("1:*", {
      uid: true,
      flags: true,
      source: true
    })) {
      if (message.flags?.has("\\Seen")) {
        continue;
      }

      const rawEmail = Buffer.from(message.source ?? "").toString("utf8");
      const subject = parseHeader(rawEmail, "Subject") ?? "Feedback submission";
      const from = parseHeader(rawEmail, "From") ?? "unknown";
      const body = extractBody(rawEmail);
      const repoFullName = getRepoFromSubject(subject);
      if (!repoFullName) {
        logger.warn({ uid: message.uid, subject }, "Skipping email without [repo:owner/repo] tag");
        continue;
      }

      const feedback = normalize(
        {
          subject,
          rawContent: body,
          senderEmail: from,
          repoFullName,
          metadata: {
            uid: message.uid
          }
        },
        "email"
      );

      await enqueueFeedback(feedback);
      await this.client.messageFlagsAdd(message.uid.toString(), ["\\Seen"]);
    }
  }
}

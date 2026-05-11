import type { FastifyReply, FastifyRequest } from "fastify";
import { ValidationError, type FeedbackSource } from "@mosaic/core";

import { normalize } from "../normalizer.js";
import { enqueueFeedback } from "../queue.js";

interface GithubWebhookBody {
  action?: string;
  sender?: {
    login?: string;
  };
  repository?: {
    full_name?: string;
  };
  issue?: {
    body?: string | null;
    user?: {
      login?: string;
    };
    html_url?: string;
    number?: number;
  };
  comment?: {
    body?: string | null;
    user?: {
      login?: string;
    };
    html_url?: string;
    id?: number;
  };
}

function isMosaicBotLogin(login: string | undefined): boolean {
  return login === "mosaicfeedback[bot]" || login === "app/mosaicfeedback";
}

export function isMosaicAuthoredPayload(payload: GithubWebhookBody): boolean {
  return isMosaicBotLogin(payload.sender?.login) ||
    isMosaicBotLogin(payload.issue?.user?.login) ||
    isMosaicBotLogin(payload.comment?.user?.login);
}

export function extractGithubFeedback(payload: GithubWebhookBody): {
  source: FeedbackSource;
  normalizedInput: Record<string, unknown>;
} {
  const repoFullName = payload.repository?.full_name;
  if (!repoFullName) {
    throw new ValidationError("GitHub webhook payload missing repository.full_name");
  }

  if (payload.comment?.body) {
    return {
      source: "github_comment",
      normalizedInput: {
        rawContent: payload.comment.body,
        repoFullName,
        senderIdentifier: payload.comment.user?.login ?? "unknown",
        metadata: {
          action: payload.action,
          issueNumber: payload.issue?.number,
          url: payload.comment.html_url,
          commentId: payload.comment.id
        }
      }
    };
  }

  return {
    source: "github_issue",
    normalizedInput: {
      rawContent: payload.issue?.body ?? "",
      repoFullName,
      senderIdentifier: payload.issue?.user?.login ?? "unknown",
      metadata: {
        action: payload.action,
        issueNumber: payload.issue?.number,
        url: payload.issue?.html_url
      }
    }
  };
}

export async function handleGithubWebhook(
  request: FastifyRequest<{ Body: GithubWebhookBody }>,
  reply: FastifyReply
): Promise<void> {
  if (isMosaicAuthoredPayload(request.body)) {
    reply.code(202).send({ accepted: false, ignored: true, reason: "mosaic-authored-event" });
    return;
  }

  const extracted = extractGithubFeedback(request.body);
  const feedback = normalize(extracted.normalizedInput, extracted.source);
  await enqueueFeedback(feedback);
  reply.code(202).send({ accepted: true, feedbackId: feedback.id });
}

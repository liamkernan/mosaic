import { getEnv, RateLimitError, type FeedbackItem, logger } from "@mosaic/core";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

import { enforceSubmissionProtection } from "./abuse-protection.js";

export const FEEDBACK_QUEUE_NAME = "feedback-intake";

const connection = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });

export const feedbackQueue = new Queue(FEEDBACK_QUEUE_NAME, {
  connection
});

async function enforceFeedbackRateLimit(repoFullName: string): Promise<void> {
  const bucket = new Date().toISOString().slice(0, 13);
  const key = `feedback-rate:${repoFullName}:${bucket}`;
  const total = await connection.incr(key);
  if (total === 1) {
    await connection.expire(key, 3600);
  }

  if (total > getEnv().FEEDBACK_ITEMS_PER_HOUR) {
    throw new RateLimitError(`Feedback item rate limit exceeded for ${repoFullName}`);
  }
}

export async function enqueueFeedback(feedbackItem: FeedbackItem): Promise<void> {
  await enforceFeedbackRateLimit(feedbackItem.repoFullName);
  await enforceSubmissionProtection(feedbackItem, connection);
  await feedbackQueue.add(
    "feedback-item",
    feedbackItem,
    {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1_000
      }
    }
  );
  logger.info({ feedbackId: feedbackItem.id, repoFullName: feedbackItem.repoFullName }, "Queued feedback item");
}

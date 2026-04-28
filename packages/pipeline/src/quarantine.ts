import { getEnv, logger, type ClassifiedFeedback } from "@mosaic/core";
import { Redis } from "ioredis";

export interface QuarantinedFeedbackRecord {
  feedbackId: string;
  repoFullName: string;
  senderIdentifier: string;
  summary: string;
  complexity: string;
  category: string;
  reason: string;
  rawContent: string;
  quarantinedAt: string;
}

export class QuarantineStore {
  private readonly redis = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });

  async quarantine(feedback: ClassifiedFeedback, reason: string): Promise<void> {
    const record: QuarantinedFeedbackRecord = {
      feedbackId: feedback.id,
      repoFullName: feedback.repoFullName,
      senderIdentifier: feedback.senderIdentifier,
      summary: feedback.summary,
      complexity: feedback.complexity,
      category: feedback.category,
      reason,
      rawContent: feedback.rawContent.slice(0, 2_000),
      quarantinedAt: new Date().toISOString()
    };

    const repoKey = `feedback-quarantine:${feedback.repoFullName}`;
    await this.redis.lpush(repoKey, JSON.stringify(record));
    await this.redis.ltrim(repoKey, 0, 199);
    logger.warn({ feedbackId: feedback.id, repo: feedback.repoFullName, reason }, "Feedback quarantined");
  }
}

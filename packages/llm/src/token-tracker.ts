import { getEnv, logger } from "@mosaic/core";
import { Redis } from "ioredis";

export interface TokenUsageEvent {
  repoFullName: string;
  feedbackId: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  timestamp: number;
}

let redisClient: Redis | undefined;

function getRedis(): Redis {
  redisClient ??= new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return redisClient;
}

function usageKey(repoFullName: string, timestamp: number): string {
  const month = new Date(timestamp).toISOString().slice(0, 7);
  return `tokens:${repoFullName}:${month}`;
}

function usageKeysBetween(repoFullName: string, startedAt: number, finishedAt: number): string[] {
  const keys: string[] = [];
  const cursor = new Date(startedAt);
  cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);

  while (cursor.getTime() <= finishedAt) {
    keys.push(usageKey(repoFullName, cursor.getTime()));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return keys;
}

export async function trackUsage(event: TokenUsageEvent): Promise<void> {
  const member = JSON.stringify(event);
  await getRedis().zadd(usageKey(event.repoFullName, event.timestamp), event.timestamp, member);
  logger.info({ tokenUsage: event }, "Tracked LLM usage");
}

export async function getUsage(
  repoFullName: string,
  month: string
): Promise<{ inputTokens: number; outputTokens: number }> {
  const key = `tokens:${repoFullName}:${month}`;
  const records = await getRedis().zrange(key, 0, -1);

  return records.reduce(
    (accumulator: { inputTokens: number; outputTokens: number }, record: string) => {
      const parsed = JSON.parse(record) as TokenUsageEvent;
      accumulator.inputTokens += parsed.inputTokens;
      accumulator.outputTokens += parsed.outputTokens;
      return accumulator;
    },
    { inputTokens: 0, outputTokens: 0 }
  );
}

export function summarizeFeedbackUsageRecords(
  recordsByKey: string[][],
  feedbackId: string
): { inputTokens: number; outputTokens: number } {
  const usage = { inputTokens: 0, outputTokens: 0 };

  for (const records of recordsByKey) {
    for (const record of records) {
      const parsed = JSON.parse(record) as TokenUsageEvent;
      if (parsed.feedbackId === feedbackId) {
        usage.inputTokens += parsed.inputTokens;
        usage.outputTokens += parsed.outputTokens;
      }
    }
  }

  return usage;
}

export async function getFeedbackUsage(
  repoFullName: string,
  feedbackId: string,
  startedAt: number,
  finishedAt: number
): Promise<{ inputTokens: number; outputTokens: number }> {
  const recordsByKey = await Promise.all(
    usageKeysBetween(repoFullName, startedAt, finishedAt)
      .map((key) => getRedis().zrangebyscore(key, startedAt, finishedAt))
  );
  return summarizeFeedbackUsageRecords(recordsByKey, feedbackId);
}

export function resetTokenTrackerForTests(): void {
  if (redisClient) {
    redisClient.disconnect();
    redisClient = undefined;
  }
}

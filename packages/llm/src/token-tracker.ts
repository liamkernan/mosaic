import { getEnv, logger } from "@feedbackbot/core";
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

export function resetTokenTrackerForTests(): void {
  if (redisClient) {
    redisClient.disconnect();
    redisClient = undefined;
  }
}

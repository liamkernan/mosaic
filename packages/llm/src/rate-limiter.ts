import { getEnv, RateLimitError } from "@mosaic/core";
import { Redis } from "ioredis";

let redisClient: Redis | undefined;

function getRedis(): Redis {
  redisClient ??= new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return redisClient;
}

function hourBucket(timestamp = Date.now()): string {
  return new Date(timestamp).toISOString().slice(0, 13);
}

export async function enforceRepoRateLimit(
  repoFullName: string,
  limit = getEnv().LLM_CALLS_PER_HOUR
): Promise<void> {
  const key = `ratelimit:${repoFullName}:${hourBucket()}`;
  const total = await getRedis().incr(key);
  if (total === 1) {
    await getRedis().expire(key, 3600);
  }

  if (total > limit) {
    throw new RateLimitError(`Rate limit exceeded for ${repoFullName}`);
  }
}

export function resetRateLimiterForTests(): void {
  if (redisClient) {
    redisClient.disconnect();
    redisClient = undefined;
  }
}

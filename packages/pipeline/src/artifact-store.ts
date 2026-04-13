import type { Redis } from "ioredis";

export type ArtifactType = "issue" | "pr" | "quarantine";

export interface ArtifactRecord {
  feedbackId: string;
  repoFullName: string;
  artifactType: ArtifactType;
  artifactValue: string;
  createdAt: string;
}

type MinimalRedis = Pick<Redis, "get" | "set">;

const ARTIFACT_KEY_PREFIX = "feedback-artifact";
const ARTIFACT_TTL_SECONDS = 30 * 24 * 60 * 60;

function artifactKey(feedbackId: string): string {
  return `${ARTIFACT_KEY_PREFIX}:${feedbackId}`;
}

export class ArtifactStore {
  constructor(private readonly redis: MinimalRedis) {}

  async get(feedbackId: string): Promise<ArtifactRecord | null> {
    const raw = await this.redis.get(artifactKey(feedbackId));
    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as ArtifactRecord;
  }

  async record(record: ArtifactRecord): Promise<boolean> {
    const result = await this.redis.set(
      artifactKey(record.feedbackId),
      JSON.stringify(record),
      "EX",
      ARTIFACT_TTL_SECONDS,
      "NX"
    );

    return result === "OK";
  }
}

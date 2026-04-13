import { describe, expect, it } from "vitest";

import { ArtifactStore, type ArtifactRecord } from "../packages/pipeline/src/artifact-store.js";

class FakeRedis {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    _expiryMode: string,
    _ttl: number,
    condition: string
  ): Promise<"OK" | null> {
    if (condition === "NX" && this.store.has(key)) {
      return null;
    }

    this.store.set(key, value);
    return "OK";
  }
}

function buildRecord(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    feedbackId: "01TEST",
    repoFullName: "owner/repo",
    artifactType: "pr",
    artifactValue: "https://github.com/owner/repo/pull/1",
    createdAt: "2026-04-13T00:00:00.000Z",
    ...overrides
  };
}

describe("artifact store", () => {
  it("records and retrieves a created artifact", async () => {
    const store = new ArtifactStore(new FakeRedis());
    const record = buildRecord();

    await expect(store.record(record)).resolves.toBe(true);
    await expect(store.get(record.feedbackId)).resolves.toEqual(record);
  });

  it("does not overwrite an existing artifact for the same feedback id", async () => {
    const store = new ArtifactStore(new FakeRedis());

    await expect(store.record(buildRecord())).resolves.toBe(true);
    await expect(
      store.record(
        buildRecord({
          artifactValue: "https://github.com/owner/repo/pull/2"
        })
      )
    ).resolves.toBe(false);

    await expect(store.get("01TEST")).resolves.toEqual(buildRecord());
  });
});

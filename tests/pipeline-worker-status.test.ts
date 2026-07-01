import { describe, expect, it } from "vitest";

import { formatDuration } from "../packages/pipeline/src/worker-status.js";

describe("worker status", () => {
  it.each([
    ["millisecond", 742, "742ms"],
    ["second", 12_345, "12.3s"],
    ["minute", 125_500, "2m 5.5s"]
  ])("formats %s durations", (_unit, durationMs, expected) => {
    expect(formatDuration(durationMs)).toBe(expected);
  });
});

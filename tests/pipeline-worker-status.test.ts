import { describe, expect, it } from "vitest";

import { formatDuration } from "../packages/pipeline/src/worker-status.js";

describe("worker status", () => {
  it("formats millisecond durations", () => {
    expect(formatDuration(742)).toBe("742ms");
  });

  it("formats second durations", () => {
    expect(formatDuration(12_345)).toBe("12.3s");
  });

  it("formats minute durations", () => {
    expect(formatDuration(125_500)).toBe("2m 5.5s");
  });
});

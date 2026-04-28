import { describe, expect, it, vi } from "vitest";

vi.mock("../packages/core/src/index.js", () => ({
  getEnv: () => ({ PORT: 3000, MOSAIC_TRIGGER_PHRASE: "@feedbackbot" }),
  logger: {
    info: vi.fn()
  }
}));

import { bodyContainsTrigger } from "../packages/github-app/src/app.js";

describe("github app forwarding triggers", () => {
  it("matches the trigger phrase case-insensitively", () => {
    const context = {
      payload: {
        comment: {
          body: "@FeedbackBot fix this"
        }
      }
    } as never;

    expect(bodyContainsTrigger(context)).toBe(true);
  });

  it("ignores promotion commands without the app mention", () => {
    const context = {
      payload: {
        comment: {
          body: "fix this"
        }
      }
    } as never;

    expect(bodyContainsTrigger(context)).toBe(false);
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as GithubApp from "../packages/github-app/src/app.js";

import { resetEnvForTests } from "../packages/core/src/index.js";

let bodyContainsTrigger: typeof GithubApp.bodyContainsTrigger;
let isMosaicAuthoredEvent: typeof GithubApp.isMosaicAuthoredEvent;

beforeAll(async () => {
  vi.stubEnv("MOSAIC_TRIGGER_PHRASE", "@custombot");
  resetEnvForTests();
  ({ bodyContainsTrigger, isMosaicAuthoredEvent } = await import("../packages/github-app/src/app.js"));
});

afterAll(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe("github app forwarding triggers", () => {
  it("matches the trigger phrase case-insensitively", () => {
    const context = {
      payload: {
        comment: {
          body: "@CustomBot fix this"
        }
      }
    } as never;

    expect(bodyContainsTrigger(context)).toBe(true);
  });

  it("always matches the mosaic trigger alias", () => {
    const context = {
      payload: {
        comment: {
          body: "@mosaic fix this"
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

  it("detects Mosaic-authored issue events", () => {
    const context = {
      payload: {
        sender: { login: "mosaicfeedback[bot]" },
        issue: {
          user: { login: "mosaicfeedback[bot]" }
        },
        repository: {
          full_name: "owner/repo"
        }
      }
    } as never;

    expect(isMosaicAuthoredEvent(context)).toBe(true);
  });

  it("allows user comments on Mosaic-authored staged issues", () => {
    const context = {
      payload: {
        sender: { login: "liamkernan" },
        issue: {
          user: { login: "mosaicfeedback[bot]" }
        },
        comment: {
          user: { login: "liamkernan" },
          body: "@mosaic fix this"
        },
        repository: {
          full_name: "owner/repo"
        }
      }
    } as never;

    expect(isMosaicAuthoredEvent(context)).toBe(false);
  });
});

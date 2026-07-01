import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetEnvForTests } from "../packages/core/src/index.js";
import { createIntakeServer } from "../packages/intake/src/server.js";
import { enqueueFeedback } from "../packages/intake/src/queue.js";

vi.mock("../packages/intake/src/queue.js", () => ({
  enqueueFeedback: vi.fn()
}));

describe("trusted intake webhooks", () => {
  const originalSecret = process.env.MOSAIC_INTAKE_SHARED_SECRET;

  beforeEach(() => {
    process.env.MOSAIC_INTAKE_SHARED_SECRET = "test-intake-secret";
    resetEnvForTests();
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.MOSAIC_INTAKE_SHARED_SECRET;
    } else {
      process.env.MOSAIC_INTAKE_SHARED_SECRET = originalSecret;
    }

    resetEnvForTests();
    vi.clearAllMocks();
  });

  it.each([
    {
      name: "generic form",
      url: "/webhook/form",
      payload: {
        message: "Fix the checkout copy",
        repoFullName: "owner/repo"
      }
    },
    {
      name: "GitHub",
      url: "/webhook/github",
      payload: {
        action: "opened",
        repository: { full_name: "owner/repo" },
        issue: {
          body: "@mosaic fix this",
          user: { login: "user" },
          number: 1
        }
      }
    },
    {
      name: "Slack",
      url: "/webhook/slack",
      payload: {
        message: "Fix the checkout copy",
        repoFullName: "owner/repo",
        userId: "U123",
        channelId: "C123"
      }
    },
    {
      name: "Discord",
      url: "/webhook/discord",
      payload: {
        message: "Fix the checkout copy",
        repoFullName: "owner/repo",
        userId: "123",
        channelId: "456"
      }
    }
  ])("rejects unauthenticated $name requests", async ({ url, payload }) => {
    const { server } = await createIntakeServer();
    try {
      const response = await server.inject({
        method: "POST",
        url,
        payload
      });

      expect(response.statusCode, response.body).toBe(403);
      expect(enqueueFeedback).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it.each([
    {
      name: "generic form",
      url: "/webhook/form",
      payload: {
        message: "Fix the checkout copy",
        repoFullName: "owner/repo"
      }
    },
    {
      name: "GitHub",
      url: "/webhook/github",
      payload: {
        action: "opened",
        repository: { full_name: "owner/repo" },
        issue: {
          body: "@mosaic fix this",
          user: { login: "user" },
          number: 1
        }
      }
    },
    {
      name: "Slack",
      url: "/webhook/slack",
      payload: {
        message: "Fix the checkout copy",
        repoFullName: "owner/repo",
        userId: "U123",
        channelId: "C123"
      }
    },
    {
      name: "Discord",
      url: "/webhook/discord",
      payload: {
        message: "Fix the checkout copy",
        repoFullName: "owner/repo",
        userId: "123",
        channelId: "456"
      }
    }
  ])("accepts authenticated $name requests", async ({ url, payload }) => {
    const { server } = await createIntakeServer();
    try {
      const response = await server.inject({
        method: "POST",
        url,
        headers: {
          "x-mosaic-intake-secret": "test-intake-secret"
        },
        payload
      });

      expect(response.statusCode, response.body).toBe(202);
      expect(enqueueFeedback).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("accepts bearer token authentication for trusted routes", async () => {
    const { server } = await createIntakeServer();
    try {
      const response = await server.inject({
        method: "POST",
        url: "/webhook/form",
        headers: {
          authorization: "Bearer test-intake-secret"
        },
        payload: {
          message: "Fix the checkout copy",
          repoFullName: "owner/repo"
        }
      });

      expect(response.statusCode, response.body).toBe(202);
      expect(enqueueFeedback).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});

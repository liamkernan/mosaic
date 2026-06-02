import { describe, expect, it } from "vitest";

import { stripSlackBotMention } from "../packages/slack-bot/src/bot.js";
import { parseSlackRepoMappings, resolveSlackRepo } from "../packages/slack-bot/src/routing.js";

describe("slack routing", () => {
  it("parses repo mappings", () => {
    const mappings = parseSlackRepoMappings(JSON.stringify([
      {
        teamId: "team-1",
        channelId: "channel-1",
        repoFullName: "owner/repo"
      }
    ]));

    expect(mappings).toEqual([
      {
        teamId: "team-1",
        channelId: "channel-1",
        repoFullName: "owner/repo"
      }
    ]);
  });

  it("prefers exact channel mappings over team defaults", () => {
    const mappings = parseSlackRepoMappings(JSON.stringify([
      {
        teamId: "team-1",
        repoFullName: "owner/default"
      },
      {
        teamId: "team-1",
        channelId: "channel-1",
        repoFullName: "owner/specific"
      }
    ]));

    expect(resolveSlackRepo({ teamId: "team-1", channelId: "channel-1" }, mappings)).toBe("owner/specific");
  });

  it("falls back to the local default repo", () => {
    expect(resolveSlackRepo({ teamId: "team-1", channelId: "channel-1" }, [], "owner/local")).toBe("owner/local");
  });

  it("strips Slack bot mentions", () => {
    expect(stripSlackBotMention("<@U123> fix the login copy", "U123")).toBe("fix the login copy");
  });
});

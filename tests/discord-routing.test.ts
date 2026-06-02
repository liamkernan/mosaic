import { describe, expect, it } from "vitest";

import { parseDiscordRepoMappings, resolveDiscordRepo } from "../packages/discord-bot/src/routing.js";
import { stripBotMention } from "../packages/discord-bot/src/bot.js";

describe("discord routing", () => {
  it("parses repo mappings", () => {
    const mappings = parseDiscordRepoMappings(JSON.stringify([
      {
        guildId: "guild-1",
        channelId: "channel-1",
        repoFullName: "owner/repo"
      }
    ]));

    expect(mappings).toEqual([
      {
        guildId: "guild-1",
        channelId: "channel-1",
        repoFullName: "owner/repo"
      }
    ]);
  });

  it("prefers exact channel mappings over guild defaults", () => {
    const mappings = parseDiscordRepoMappings(JSON.stringify([
      {
        guildId: "guild-1",
        repoFullName: "owner/default"
      },
      {
        guildId: "guild-1",
        channelId: "channel-1",
        repoFullName: "owner/specific"
      }
    ]));

    expect(resolveDiscordRepo({ guildId: "guild-1", channelId: "channel-1" }, mappings)).toBe("owner/specific");
  });

  it("falls back to the local default repo", () => {
    expect(resolveDiscordRepo({ guildId: "guild-1", channelId: "channel-1" }, [], "owner/local")).toBe("owner/local");
  });

  it("strips regular and nickname bot mentions", () => {
    expect(stripBotMention("<@123> fix the login copy", "123")).toBe("fix the login copy");
    expect(stripBotMention("<@!123> fix the login copy", "123")).toBe("fix the login copy");
  });
});

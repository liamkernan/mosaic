import { repoFullNamePattern } from "@mosaic/core";

export interface DiscordRepoMapping {
  repoFullName: string;
  guildId?: string;
  channelId?: string;
}

export interface DiscordRouteContext {
  guildId?: string | null;
  channelId: string;
}

function normalizeOptionalId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function assertRepoFullName(repoFullName: string): void {
  if (!repoFullNamePattern.test(repoFullName)) {
    throw new Error(`Invalid Discord repo mapping repoFullName: ${repoFullName}`);
  }
}

export function parseDiscordRepoMappings(input?: string): DiscordRepoMapping[] {
  if (!input || input.trim().length === 0) {
    return [];
  }

  const parsed = JSON.parse(input) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("DISCORD_REPO_MAPPINGS must be a JSON array");
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`DISCORD_REPO_MAPPINGS[${index}] must be an object`);
    }

    const value = entry as Record<string, unknown>;
    const repoFullName = normalizeOptionalId(value.repoFullName);
    if (!repoFullName) {
      throw new Error(`DISCORD_REPO_MAPPINGS[${index}].repoFullName is required`);
    }

    assertRepoFullName(repoFullName);

    const mapping: DiscordRepoMapping = {
      repoFullName,
      guildId: normalizeOptionalId(value.guildId),
      channelId: normalizeOptionalId(value.channelId)
    };

    if (!mapping.guildId && !mapping.channelId) {
      throw new Error(`DISCORD_REPO_MAPPINGS[${index}] must include guildId or channelId`);
    }

    return mapping;
  });
}

export function resolveDiscordRepo(
  context: DiscordRouteContext,
  mappings: DiscordRepoMapping[],
  defaultRepoFullName?: string
): string {
  const guildId = context.guildId?.trim();
  const channelId = context.channelId.trim();

  const exactChannelAndGuild = mappings.find(
    (mapping) => mapping.guildId === guildId && mapping.channelId === channelId
  );
  if (exactChannelAndGuild) {
    return exactChannelAndGuild.repoFullName;
  }

  const channelOnly = mappings.find((mapping) => !mapping.guildId && mapping.channelId === channelId);
  if (channelOnly) {
    return channelOnly.repoFullName;
  }

  const guildOnly = mappings.find((mapping) => mapping.guildId === guildId && !mapping.channelId);
  if (guildOnly) {
    return guildOnly.repoFullName;
  }

  if (defaultRepoFullName && defaultRepoFullName.trim().length > 0) {
    assertRepoFullName(defaultRepoFullName.trim());
    return defaultRepoFullName.trim();
  }

  throw new Error("No Discord repo mapping matched this message");
}

import { repoFullNamePattern } from "@mosaic/core";

export interface SlackRepoMapping {
  repoFullName: string;
  teamId?: string;
  channelId?: string;
}

export interface SlackRouteContext {
  teamId?: string | null;
  channelId: string;
}

function normalizeOptionalId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function assertRepoFullName(repoFullName: string): void {
  if (!repoFullNamePattern.test(repoFullName)) {
    throw new Error(`Invalid Slack repo mapping repoFullName: ${repoFullName}`);
  }
}

export function parseSlackRepoMappings(input?: string): SlackRepoMapping[] {
  if (!input || input.trim().length === 0) {
    return [];
  }

  const parsed = JSON.parse(input) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("SLACK_REPO_MAPPINGS must be a JSON array");
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`SLACK_REPO_MAPPINGS[${index}] must be an object`);
    }

    const value = entry as Record<string, unknown>;
    const repoFullName = normalizeOptionalId(value.repoFullName);
    if (!repoFullName) {
      throw new Error(`SLACK_REPO_MAPPINGS[${index}].repoFullName is required`);
    }

    assertRepoFullName(repoFullName);

    const mapping: SlackRepoMapping = {
      repoFullName,
      teamId: normalizeOptionalId(value.teamId),
      channelId: normalizeOptionalId(value.channelId)
    };

    if (!mapping.teamId && !mapping.channelId) {
      throw new Error(`SLACK_REPO_MAPPINGS[${index}] must include teamId or channelId`);
    }

    return mapping;
  });
}

export function resolveSlackRepo(
  context: SlackRouteContext,
  mappings: SlackRepoMapping[],
  defaultRepoFullName?: string
): string {
  const teamId = context.teamId?.trim();
  const channelId = context.channelId.trim();

  const exactChannelAndTeam = mappings.find((mapping) => mapping.teamId === teamId && mapping.channelId === channelId);
  if (exactChannelAndTeam) {
    return exactChannelAndTeam.repoFullName;
  }

  const channelOnly = mappings.find((mapping) => !mapping.teamId && mapping.channelId === channelId);
  if (channelOnly) {
    return channelOnly.repoFullName;
  }

  const teamOnly = mappings.find((mapping) => mapping.teamId === teamId && !mapping.channelId);
  if (teamOnly) {
    return teamOnly.repoFullName;
  }

  if (defaultRepoFullName && defaultRepoFullName.trim().length > 0) {
    assertRepoFullName(defaultRepoFullName.trim());
    return defaultRepoFullName.trim();
  }

  throw new Error("No Slack repo mapping matched this message");
}

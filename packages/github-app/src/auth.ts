import { readFile } from "node:fs/promises";

import { assertRequiredEnv, getEnv } from "@mosaic/core";
import { Probot } from "probot";

type InstallationOctokit = Awaited<ReturnType<Probot["auth"]>>;

interface CachedOctokit {
  octokit: InstallationOctokit;
  expiresAt: number;
  token: string;
}

let probot: Probot | undefined;
const installationCache = new Map<number, CachedOctokit>();

async function createProbot(): Promise<Probot> {
  if (probot) {
    return probot;
  }

  assertRequiredEnv("GITHUB_APP_ID", "GITHUB_PRIVATE_KEY_PATH", "GITHUB_WEBHOOK_SECRET");
  const env = getEnv();
  const privateKey = await readFile(env.GITHUB_PRIVATE_KEY_PATH, "utf8");

  probot = new Probot({
    appId: env.GITHUB_APP_ID!,
    privateKey,
    secret: env.GITHUB_WEBHOOK_SECRET!
  });

  return probot;
}

export async function getProbot(): Promise<Probot> {
  return createProbot();
}

export async function getOctokit(installationId: number): Promise<InstallationOctokit> {
  const cached = installationCache.get(installationId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.octokit;
  }

  const app = await createProbot();
  const octokit = await app.auth(installationId);
  const authResult = (await octokit.auth({
    type: "installation",
    installationId
  })) as { token: string };

  installationCache.set(installationId, {
    octokit,
    token: authResult.token,
    expiresAt: Date.now() + 55 * 60 * 1_000
  });

  return octokit;
}

export async function getInstallationToken(installationId: number): Promise<string> {
  const cached = installationCache.get(installationId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  await getOctokit(installationId);
  const refreshed = installationCache.get(installationId);
  if (!refreshed) {
    throw new Error(`Installation token cache missing for ${installationId}`);
  }

  return refreshed.token;
}

export async function resolveInstallationId(repoFullName: string): Promise<number> {
  const [owner, repo] = repoFullName.split("/");
  const app = await createProbot();
  const appOctokit = await app.auth();
  const response = await appOctokit.request("GET /repos/{owner}/{repo}/installation", {
    owner,
    repo
  });

  return response.data.id;
}

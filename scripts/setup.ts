import { access, copyFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";

async function ensureEnvFile(cwd: string): Promise<void> {
  const envPath = join(cwd, ".env");
  try {
    await access(envPath);
  } catch {
    await copyFile(join(cwd, ".env.example"), envPath);
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  await ensureEnvFile(cwd);

  const rl = createInterface({ input, output });
  const githubAppId = await rl.question("GitHub App ID: ");
  const webhookSecret = await rl.question("GitHub webhook secret: ");
  const redisUrl = await rl.question("Redis URL [redis://localhost:6379]: ");
  const anthropicKey = await rl.question("Anthropic API key (optional): ");
  rl.close();

  const envContents = [
    `GITHUB_APP_ID=${githubAppId}`,
    "GITHUB_PRIVATE_KEY_PATH=./private-key.pem",
    `GITHUB_WEBHOOK_SECRET=${webhookSecret}`,
    `REDIS_URL=${redisUrl || "redis://localhost:6379"}`,
    `ANTHROPIC_API_KEY=${anthropicKey}`
  ].join("\n");

  await writeFile(join(cwd, ".env"), `${envContents}\n`, "utf8");
  output.write("Wrote .env with the provided configuration.\n");
}

void main();

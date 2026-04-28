import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env");
try {
  const envContents = readFileSync(envPath, "utf8");
  for (const line of envContents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // Ignore missing .env and fall back to the process environment.
}

const smeeUrl = process.env.SMEE_URL;
if (!smeeUrl) {
  console.error("SMEE_URL is not set. Set it to your GitHub App smee.io URL.");
  process.exit(1);
}

const target = `http://127.0.0.1:${process.env.GITHUB_APP_PORT || 3001}/api/github/webhooks`;

const child = spawn("pnpm", ["exec", "smee", "--url", smeeUrl, "--target", target], {
  stdio: "inherit"
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

import { pathToFileURL } from "node:url";

import { getEnv, logger } from "@mosaic/core";
import { run } from "probot";

import app from "./app.js";

export * from "./app.js";
export * from "./auth.js";

async function startGithubApp(): Promise<void> {
  process.env.PORT = String(getEnv().GITHUB_APP_PORT);
  await run(app);
}

const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMainModule && process.env.NODE_ENV !== "test") {
  void startGithubApp().catch((error) => {
    logger.error({ err: error }, "Failed to start GitHub App");
    process.exitCode = 1;
  });
}

import { pathToFileURL } from "node:url";

import { logger } from "@mosaic/core";

export * from "./bot.js";
export * from "./routing.js";

const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMainModule && process.env.NODE_ENV !== "test") {
  void import("./bot.js").then(({ startSlackBot }) => startSlackBot()).catch((error) => {
    logger.error({ err: error }, "Failed to start Slack bot");
    process.exitCode = 1;
  });
}

import { pathToFileURL } from "node:url";

import { logger } from "@mosaic/core";

export * from "./adapters/discord.adapter.js";
export * from "./adapters/email.adapter.js";
export * from "./adapters/github.adapter.js";
export * from "./adapters/webhook.adapter.js";
export * from "./abuse-protection.js";
export * from "./normalizer.js";
export * from "./queue.js";
export * from "./server.js";

const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMainModule && process.env.NODE_ENV !== "test") {
  void import("./server.js").then(({ startIntakeServer }) => startIntakeServer()).catch((error) => {
    logger.error({ err: error }, "Failed to start intake server");
    process.exitCode = 1;
  });
}

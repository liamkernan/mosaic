import { logger } from "@mosaic/core";

export * from "./anthropic.js";
export * from "./client.js";
export * from "./rate-limiter.js";
export * from "./token-tracker.js";

if (process.env.NODE_ENV !== "test" && process.argv[1]?.endsWith("index.js")) {
  logger.info("LLM package loaded");
}

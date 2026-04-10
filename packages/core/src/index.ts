import { logger } from "./logger.js";

export * from "./config.js";
export * from "./errors.js";
export * from "./logger.js";
export * from "./types.js";

if (process.env.NODE_ENV !== "test" && process.argv[1]?.endsWith("index.js")) {
  logger.info("Core package loaded");
}

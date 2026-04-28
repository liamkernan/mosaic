import pino from "pino";

import { getEnv } from "./config.js";

export const logger = pino({
  name: "mosaic",
  level: getEnv().LOG_LEVEL
});

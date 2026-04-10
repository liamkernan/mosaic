import { pathToFileURL } from "node:url";

import { logger } from "@feedbackbot/core";

import { FeedbackPipelineWorker } from "./worker.js";

export * from "./classifier.js";
export * from "./code-generator.js";
export * from "./disposition.js";
export * from "./issue-creator.js";
export * from "./pr-creator.js";
export * from "./quarantine.js";
export * from "./repo-config.js";
export * from "./repo-indexer.js";
export * from "./validator.js";
export * from "./worker.js";
export * from "./prompts/classify.prompt.js";
export * from "./prompts/generate.prompt.js";
export * from "./prompts/summarize.prompt.js";

async function startWorker(): Promise<void> {
  const worker = new FeedbackPipelineWorker().createWorker();
  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, err: error }, "Feedback job failed");
  });
  logger.info("Feedback pipeline worker started");
}

const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMainModule && process.env.NODE_ENV !== "test") {
  void startWorker().catch((error) => {
    logger.error({ err: error }, "Failed to start feedback pipeline worker");
    process.exitCode = 1;
  });
}

import { pathToFileURL } from "node:url";

import { logger } from "@mosaic/core";

import { FeedbackPipelineWorker } from "./worker.js";
import { logCompletedWorkerStatus, logFailedWorkerStatus } from "./worker-status.js";

export * from "./classifier.js";
export * from "./classification-routing.js";
export * from "./code-generator.js";
export * from "./artifact-store.js";
export * from "./disposition.js";
export * from "./generated-change-parser.js";
export * from "./implementation-planner.js";
export * from "./issue-creator.js";
export * from "./model-routing.js";
export * from "./pr-creator.js";
export * from "./quarantine.js";
export * from "./repo-config.js";
export * from "./repo-indexer.js";
export * from "./staged-issues.js";
export * from "./transient-llm.js";
export * from "./validator.js";
export * from "./verification-runner.js";
export * from "./worker.js";
export * from "./worker-status.js";
export * from "./prompts/classify.prompt.js";
export * from "./prompts/generate.prompt.js";
export * from "./prompts/implementation-plan.prompt.js";
export * from "./prompts/repair-generate.prompt.js";
export * from "./prompts/summarize.prompt.js";

async function startWorker(): Promise<void> {
  const worker = new FeedbackPipelineWorker().createWorker();
  worker.on("completed", (job, result) => {
    void logCompletedWorkerStatus(job, result);
  });
  worker.on("failed", (job, error) => {
    void logFailedWorkerStatus(job, error);
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

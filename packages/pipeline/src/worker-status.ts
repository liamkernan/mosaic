import { logger, type FeedbackItem } from "@mosaic/core";
import { getFeedbackUsage } from "@mosaic/llm";
import type { Job } from "bullmq";

import type { FeedbackJobResult } from "./worker.js";

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  const totalSeconds = durationMs / 1_000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

async function logFinalWorkerStatus(
  job: Job<FeedbackItem, FeedbackJobResult>,
  outcome: "succeeded" | "failed" | "requeued",
  reason: string
): Promise<void> {
  const startedAt = job.processedOn ?? job.timestamp;
  const finishedAt = job.finishedOn ?? Date.now();
  const totalTimeMs = Math.max(0, finishedAt - startedAt);
  let inputTokens = 0;
  let outputTokens = 0;
  let tokenUsageUnavailable = false;

  try {
    const usage = await getFeedbackUsage(job.data.repoFullName, job.data.id, startedAt, finishedAt);
    inputTokens = usage.inputTokens;
    outputTokens = usage.outputTokens;
  } catch {
    tokenUsageUnavailable = true;
  }

  const totalTokens = inputTokens + outputTokens;
  const tokenSummary = tokenUsageUnavailable
    ? "unavailable"
    : `${totalTokens.toLocaleString("en-US")} (${inputTokens.toLocaleString("en-US")} input, ${outputTokens.toLocaleString("en-US")} output)`;
  const message = `Worker finished: ${outcome.toUpperCase()} | reason: ${reason} | tokens: ${tokenSummary} | total time: ${formatDuration(totalTimeMs)}`;
  const details = {
    jobId: job.id,
    feedbackId: job.data.id,
    repo: job.data.repoFullName,
    outcome,
    reason,
    inputTokens,
    outputTokens,
    totalTokens,
    tokenUsageUnavailable,
    totalTimeMs
  };

  if (outcome === "failed") {
    logger.error(details, message);
  } else if (outcome === "requeued") {
    logger.warn(details, message);
  } else {
    logger.info(details, message);
  }
}

export async function logCompletedWorkerStatus(job: Job<FeedbackItem, FeedbackJobResult>, result: FeedbackJobResult): Promise<void> {
  await logFinalWorkerStatus(job, result.outcome, result.reason);
}

export async function logFailedWorkerStatus(job: Job<FeedbackItem, FeedbackJobResult> | undefined, error: Error): Promise<void> {
  if (!job) {
    logger.error({ err: error }, `Worker finished: FAILED | reason: ${error.message} | tokens: unavailable | total time: unavailable`);
    return;
  }

  await logFinalWorkerStatus(job, "failed", error.message);
}

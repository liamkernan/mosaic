import { LLMError, type ClassifiedFeedback, type RelevantFile } from "@mosaic/core";
import type { LLMClient } from "@mosaic/llm";
import { z } from "zod";

import { buildImplementationPlanPrompt } from "./prompts/implementation-plan.prompt.js";

const PLAN_TIMEOUT_MS = 90_000;

const planFileSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1)
});

const implementationPlanSchema = z.object({
  requiredFiles: z.array(planFileSchema).default([]),
  implementationChecklist: z.array(z.string().min(1)).default([]),
  verificationChecklist: z.array(z.string().min(1)).default([])
});

export type ImplementationPlan = z.infer<typeof implementationPlanSchema>;

function extractJsonObject(response: string): string {
  const trimmed = response.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  throw new LLMError("Implementation planning returned invalid JSON");
}

function normalizePath(path: string): string {
  return path.replace(/^\.?\//, "").trim();
}

function repoContainsPath(fileTree: string[], path: string): boolean {
  return fileTree.includes(path);
}

export class ImplementationPlanner {
  constructor(private readonly llmClient: LLMClient) {}

  async plan(
    feedback: ClassifiedFeedback,
    relevantFiles: RelevantFile[],
    fileTree: string[]
  ): Promise<ImplementationPlan> {
    this.llmClient.setUsageContext({
      repoFullName: feedback.repoFullName,
      feedbackId: feedback.id
    });

    const response = await this.llmClient.complete(
      buildImplementationPlanPrompt(feedback, relevantFiles, fileTree),
      "Return only the implementation plan JSON object.",
      {
        temperature: 0,
        maxTokens: 2_048,
        timeoutMs: PLAN_TIMEOUT_MS
      }
    );

    const parsed = implementationPlanSchema.parse(JSON.parse(extractJsonObject(response)));
    const loadedPaths = new Set(relevantFiles.map((file) => file.path));
    const requiredFiles = parsed.requiredFiles
      .map((file) => ({
        ...file,
        path: normalizePath(file.path)
      }))
      .filter((file) => repoContainsPath(fileTree, file.path) || loadedPaths.has(file.path));

    return {
      ...parsed,
      requiredFiles
    };
  }
}

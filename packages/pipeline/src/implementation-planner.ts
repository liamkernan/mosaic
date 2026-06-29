import { LLMError, type ClassifiedFeedback, type RelevantFile } from "@mosaic/core";
import type { LLMClient } from "@mosaic/llm";
import { z } from "zod";

import { buildImplementationPlanPrompt } from "./prompts/implementation-plan.prompt.js";
import { normalizeRepoRelativePath } from "./repo-paths.js";

const PLAN_TIMEOUT_MS = 60_000;
const PLAN_MAX_TOKENS = 4_096;

const planFileSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1)
});

const implementationPlanSchema = z.object({
  requiredFiles: z.array(planFileSchema).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  implementationChecklist: z.array(z.string().min(1)).default([]),
  verificationChecklist: z.array(z.string().min(1)).default([]),
  verificationCommands: z.array(z.string().min(1)).default([])
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

const testPathPattern = /(?:^|\/)(?:test|tests|spec|specs|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const endpointPattern = /\b(?:GET|POST|PUT|PATCH|DELETE)\s+`?(\/[a-zA-Z0-9_./:-]+)/i;

function normalizePlan(
  response: string,
  relevantFiles: RelevantFile[],
  fileTree: string[]
): ImplementationPlan {
  const parsed = implementationPlanSchema.parse(JSON.parse(extractJsonObject(response)));
  const loadedPaths = new Set(relevantFiles.map((file) => file.path));
  const repoPaths = new Set(fileTree);
  const requiredFiles = parsed.requiredFiles
    .map((file) => ({
      ...file,
      path: normalizePath(file.path)
    }))
    .filter((file) => {
      const safePath = normalizeRepoRelativePath(file.path);
      return safePath !== null &&
        (repoPaths.has(safePath) || loadedPaths.has(safePath) || testPathPattern.test(safePath));
    });

  return {
    ...parsed,
    requiredFiles
  };
}

export function validateImplementationPlan(
  plan: ImplementationPlan,
  feedback: ClassifiedFeedback
): string[] {
  const endpoint = `${feedback.summary}\n${feedback.rawContent}`.match(endpointPattern)?.[1];
  if (!endpoint) {
    return [];
  }

  const errors: string[] = [];
  const planText = JSON.stringify(plan).toLowerCase();
  const runtimeFiles = plan.requiredFiles.filter((file) => !testPathPattern.test(file.path));
  const testFiles = plan.requiredFiles.filter((file) => testPathPattern.test(file.path));
  const verificationText = plan.verificationChecklist.join("\n").toLowerCase();

  if (!planText.includes(endpoint.toLowerCase())) {
    errors.push(`Plan does not preserve the requested endpoint contract: ${endpoint}`);
  }
  if (runtimeFiles.length < 2) {
    errors.push("Endpoint plan must include both route/handler and backing service/data files");
  }
  if (testFiles.length === 0) {
    errors.push("Endpoint plan must include a unit or integration test file");
  }
  if (!verificationText.includes("unit test")) {
    errors.push("Endpoint plan must include unit-test verification for backing behavior");
  }
  if (!/(?:handler|route|http|public\s+path).{0,80}(?:test|assert|verify|check)|(?:test|assert|verify|check).{0,80}(?:handler|route|http|public\s+path)/.test(verificationText)) {
    errors.push("Endpoint plan must include handler/route verification through the public path");
  }

  return errors;
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

    const prompt = buildImplementationPlanPrompt(feedback, relevantFiles, fileTree);
    const response = await this.llmClient.complete(
      prompt,
      "Return only the implementation plan JSON object.",
      {
        temperature: 0,
        maxTokens: PLAN_MAX_TOKENS,
        timeoutMs: PLAN_TIMEOUT_MS
      }
    );

    let plan = normalizePlan(response, relevantFiles, fileTree);
    const preflightErrors = validateImplementationPlan(plan, feedback);
    if (preflightErrors.length === 0) {
      return plan;
    }

    const repairedResponse = await this.llmClient.complete(
      `${prompt}\n\nPLAN PREFLIGHT ERRORS:\n${preflightErrors.map((error) => `- ${error}`).join("\n")}\n\n` +
      `REJECTED PLAN:\n${JSON.stringify(plan, null, 2)}\n\nReturn a corrected complete plan.`,
      "Return only the corrected implementation plan JSON object.",
      {
        temperature: 0,
        maxTokens: PLAN_MAX_TOKENS,
        timeoutMs: PLAN_TIMEOUT_MS
      }
    );
    plan = normalizePlan(repairedResponse, relevantFiles, fileTree);
    const repairedErrors = validateImplementationPlan(plan, feedback);
    if (repairedErrors.length > 0) {
      throw new LLMError(`Implementation plan failed preflight: ${repairedErrors.join("; ")}`);
    }

    return plan;
  }
}

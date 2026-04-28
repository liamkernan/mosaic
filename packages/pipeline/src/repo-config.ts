import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  complexitySchema,
  feedbackCategorySchema,
  feedbackSourceSchema,
  type FeedbackCategory,
  type RepoConfig
} from "@mosaic/core";
import { z } from "zod";
import YAML from "yaml";

export const securityConfigSchema = z.object({
  max_files_changed: z.number().int().positive().default(5),
  max_lines_added: z.number().int().positive().default(200),
  block_patterns: z.array(z.string()).default(["eval(", "child_process", "exec(", "execSync", "Function("])
});

const repoConfigFileSchema = z.object({
  version: z.literal(1).default(1),
  intake: z.array(feedbackSourceSchema).default(["web_form", "github_issue"]),
  rules: z.object({
    max_complexity: complexitySchema.default("simple"),
    allowed_categories: z.array(feedbackCategorySchema).default(["bug_report", "copy_change", "ui_tweak"]),
    branch_prefix: z.string().min(1).default("mosaic/"),
    reviewers: z.array(z.string().min(1)).optional()
  }).default({}),
  llm: z.object({
    mode: z.enum(["byok", "platform"]).default("platform")
  }).default({}),
  security: securityConfigSchema.default({})
});

export type RepoConfigFile = z.infer<typeof repoConfigFileSchema>;

export interface RepoRuntimeConfig extends RepoConfig {
  security: z.infer<typeof securityConfigSchema>;
}

export const defaultRuntimeConfig: Omit<RepoRuntimeConfig, "repoFullName"> = {
  intakeSources: ["web_form", "github_issue"],
  allowedCategories: ["bug_report", "copy_change", "ui_tweak"],
  maxComplexity: "simple",
  llmKeyMode: "platform",
  branchPrefix: "mosaic/",
  reviewers: [],
  security: {
    max_files_changed: 5,
    max_lines_added: 200,
    block_patterns: ["eval(", "child_process", "exec(", "execSync", "Function("]
  }
};

export async function loadRepoRuntimeConfig(repoRoot: string, repoFullName: string): Promise<RepoRuntimeConfig> {
  const configPath = join(repoRoot, "mosaic.config.yml");

  try {
    await access(configPath);
  } catch {
    return {
      repoFullName,
      ...defaultRuntimeConfig
    };
  }

  const fileContents = await readFile(configPath, "utf8");
  const parsed = repoConfigFileSchema.parse(YAML.parse(fileContents));

  return {
    repoFullName,
    intakeSources: parsed.intake,
    allowedCategories: parsed.rules.allowed_categories as FeedbackCategory[],
    maxComplexity: parsed.rules.max_complexity,
    llmKeyMode: parsed.llm.mode,
    llmApiKey: parsed.llm.mode === "byok" ? process.env.MOSAIC_LLM_KEY : undefined,
    reviewers: parsed.rules.reviewers ?? [],
    branchPrefix: parsed.rules.branch_prefix,
    security: parsed.security
  };
}

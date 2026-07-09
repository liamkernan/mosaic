import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  complexitySchema,
  defaultSecurityConfig,
  feedbackCategorySchema,
  feedbackSourceSchema,
  llmModelPresetSchema,
  llmProviderSchema,
  type FeedbackCategory,
  type RepoConfig
} from "@mosaic/core";
import { z } from "zod";
import YAML from "yaml";

export const securityConfigSchema = z.object({
  max_files_changed: z.number().int().positive().default(defaultSecurityConfig.max_files_changed),
  max_lines_added: z.number().int().positive().default(defaultSecurityConfig.max_lines_added),
  max_changed_lines: z.number().int().positive().default(defaultSecurityConfig.max_changed_lines),
  block_patterns: z.array(z.string()).default([...defaultSecurityConfig.block_patterns])
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
    provider: llmProviderSchema.optional(),
    mode: z.enum(["byok", "platform"]).default("platform"),
    model_preset: llmModelPresetSchema.default("quality")
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
  llmProvider: "openai",
  llmKeyMode: "platform",
  llmModelPreset: "quality",
  branchPrefix: "mosaic/",
  reviewers: [],
  security: {
    ...defaultSecurityConfig,
    block_patterns: [...defaultSecurityConfig.block_patterns]
  }
};

function platformLlmProvider() {
  return llmProviderSchema.parse(process.env.MOSAIC_LLM_PROVIDER ?? "openai");
}

async function resolveRepoConfigPath(repoRoot: string): Promise<string | null> {
  const configCandidates = ["mosaic.config.yml"];

  for (const configFileName of configCandidates) {
    const configPath = join(repoRoot, configFileName);
    try {
      await access(configPath);
      return configPath;
    } catch {
      continue;
    }
  }

  return null;
}

export async function loadRepoRuntimeConfig(repoRoot: string, repoFullName: string): Promise<RepoRuntimeConfig> {
  const configPath = await resolveRepoConfigPath(repoRoot);
  if (!configPath) {
    return {
      repoFullName,
      ...defaultRuntimeConfig,
      llmProvider: platformLlmProvider()
    };
  }

  const fileContents = await readFile(configPath, "utf8");
  const parsed = repoConfigFileSchema.parse(YAML.parse(fileContents));

  return {
    repoFullName,
    intakeSources: parsed.intake,
    allowedCategories: parsed.rules.allowed_categories as FeedbackCategory[],
    maxComplexity: parsed.rules.max_complexity,
    llmProvider: parsed.llm.provider ?? platformLlmProvider(),
    llmKeyMode: parsed.llm.mode,
    llmModelPreset: parsed.llm.model_preset,
    llmApiKey: parsed.llm.mode === "byok" ? process.env.MOSAIC_LLM_KEY : undefined,
    reviewers: parsed.rules.reviewers ?? [],
    branchPrefix: parsed.rules.branch_prefix,
    security: parsed.security
  };
}

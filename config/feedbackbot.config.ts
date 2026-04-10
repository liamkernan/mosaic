import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { complexitySchema, feedbackCategorySchema, feedbackSourceSchema } from "../packages/core/src/config.js";
import { z } from "zod";
import YAML from "yaml";

export const feedbackbotConfigSchema = z.object({
  version: z.literal(1).default(1),
  intake: z.array(feedbackSourceSchema).default(["web_form", "email", "github_issue"]),
  rules: z.object({
    max_complexity: complexitySchema.default("simple"),
    allowed_categories: z.array(feedbackCategorySchema).default(["bug_report", "copy_change", "ui_tweak"]),
    branch_prefix: z.string().min(1).default("feedbackbot/"),
    reviewers: z.array(z.string().min(1)).default([])
  }).default({}),
  llm: z.object({
    mode: z.enum(["byok", "platform"]).default("byok")
  }).default({}),
  security: z.object({
    max_files_changed: z.number().int().positive().default(5),
    max_lines_added: z.number().int().positive().default(200),
    block_patterns: z.array(z.string()).default(["eval(", "child_process"])
  }).default({})
});

export type FeedbackbotConfig = z.infer<typeof feedbackbotConfigSchema>;

export async function loadFeedbackbotConfig(repoRoot: string): Promise<FeedbackbotConfig> {
  const configPath = join(repoRoot, "feedbackbot.config.yml");
  const contents = await readFile(configPath, "utf8");
  return feedbackbotConfigSchema.parse(YAML.parse(contents));
}

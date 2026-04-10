import { homedir } from "node:os";
import { resolve } from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

import { ConfigError } from "./errors.js";
import type { ComplexityLevel, FeedbackCategory, FeedbackSource } from "./types.js";

dotenv.config();

const envSchema = z.object({
  GITHUB_APP_ID: z.string().min(1).optional(),
  GITHUB_PRIVATE_KEY_PATH: z.string().min(1).default("./private-key.pem"),
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  EMAIL_IMAP_HOST: z.string().min(1).optional(),
  EMAIL_IMAP_PORT: z.coerce.number().int().positive().default(993),
  EMAIL_IMAP_USER: z.string().min(1).optional(),
  EMAIL_IMAP_PASS: z.string().min(1).optional(),
  EMAIL_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  DISCORD_BOT_TOKEN: z.string().min(1).optional(),
  DISCORD_PUBLIC_KEY: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  GITHUB_APP_PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  REPO_CACHE_DIR: z.string().min(1).default("~/.feedbackbot/repos"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(3),
  LLM_CALLS_PER_HOUR: z.coerce.number().int().positive().default(50),
  PRS_PER_HOUR: z.coerce.number().int().positive().default(10),
  FEEDBACK_ITEMS_PER_HOUR: z.coerce.number().int().positive().default(100),
  FEEDBACKBOT_TRIGGER_PHRASE: z.string().min(1).default("@feedbackbot")
});

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | undefined;

export const feedbackSourceSchema = z.enum([
  "web_form",
  "email",
  "github_issue",
  "github_comment",
  "discord",
  "api"
]) satisfies z.ZodType<FeedbackSource>;

export const feedbackCategorySchema = z.enum([
  "bug_report",
  "feature_request",
  "copy_change",
  "ui_tweak",
  "question",
  "other"
]) satisfies z.ZodType<FeedbackCategory>;

export const complexitySchema = z.enum(["trivial", "simple", "moderate", "complex"]) satisfies z.ZodType<ComplexityLevel>;

export function getEnv(): AppEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.flatten().formErrors.join(", "));
  }

  cachedEnv = {
    ...parsed.data,
    REPO_CACHE_DIR: expandHome(parsed.data.REPO_CACHE_DIR)
  };

  return cachedEnv;
}

export function expandHome(inputPath: string): string {
  if (inputPath.startsWith("~/")) {
    return resolve(homedir(), inputPath.slice(2));
  }

  return resolve(inputPath);
}

export function resetEnvForTests(): void {
  cachedEnv = undefined;
}

export function assertRequiredEnv(...keys: Array<keyof AppEnv>): void {
  const env = getEnv();
  const missing = keys.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new ConfigError(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

export const repoFullNamePattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

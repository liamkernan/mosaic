import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { z } from "zod";

import { ConfigError } from "./errors.js";
import type { ComplexityLevel, FeedbackCategory, FeedbackSource, LLMModelPreset } from "./types.js";

const packageDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(packageDir, "../../..");

dotenv.config({ path: resolve(workspaceRoot, ".env") });

function optionalNonEmptyString() {
  return z.preprocess(
    (value) => {
      if (typeof value !== "string") {
        return value;
      }

      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    },
    z.string().min(1).optional()
  );
}

function optionalBoolean() {
  return z.preprocess((value) => {
    if (value === undefined || value === null || typeof value === "boolean") {
      return value;
    }

    if (typeof value !== "string") {
      return value;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
      return undefined;
    }

    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }

    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }

    return value;
  }, z.boolean().optional());
}

const envSchema = z.object({
  NODE_ENV: optionalNonEmptyString(),
  GITHUB_APP_ID: optionalNonEmptyString(),
  GITHUB_PRIVATE_KEY_PATH: z.string().min(1).default("./private-key.pem"),
  GITHUB_WEBHOOK_SECRET: optionalNonEmptyString(),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  ANTHROPIC_API_KEY: optionalNonEmptyString(),
  EMAIL_IMAP_HOST: optionalNonEmptyString(),
  EMAIL_IMAP_PORT: z.coerce.number().int().positive().default(993),
  EMAIL_IMAP_USER: optionalNonEmptyString(),
  EMAIL_IMAP_PASS: optionalNonEmptyString(),
  EMAIL_IMAP_MAILBOX: optionalNonEmptyString(),
  EMAIL_REPO_FULL_NAME: optionalNonEmptyString(),
  EMAIL_MAILBOXES: optionalNonEmptyString(),
  EMAIL_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  DISCORD_BOT_TOKEN: optionalNonEmptyString(),
  DISCORD_PUBLIC_KEY: optionalNonEmptyString(),
  DISCORD_DEFAULT_REPO: optionalNonEmptyString(),
  DISCORD_REPO_MAPPINGS: optionalNonEmptyString(),
  DISCORD_INTAKE_URL: z.string().url().optional(),
  DISCORD_ENABLE_MESSAGE_CONTENT_INTENT: optionalBoolean(),
  SLACK_BOT_TOKEN: optionalNonEmptyString(),
  SLACK_APP_TOKEN: optionalNonEmptyString(),
  SLACK_DEFAULT_REPO: optionalNonEmptyString(),
  SLACK_REPO_MAPPINGS: optionalNonEmptyString(),
  SLACK_INTAKE_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  GITHUB_APP_PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  REPO_CACHE_DIR: z.string().min(1).default("~/.mosaic/repos"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(3),
  WORKER_LOCK_DURATION_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  WORKER_STALLED_INTERVAL_MS: z.coerce.number().int().positive().default(2 * 60 * 1000),
  WORKER_MAX_STALLED_COUNT: z.coerce.number().int().nonnegative().default(3),
  LLM_CALLS_PER_HOUR: z.coerce.number().int().positive().default(50),
  PRS_PER_HOUR: z.coerce.number().int().positive().default(10),
  FEEDBACK_ITEMS_PER_HOUR: z.coerce.number().int().positive().default(100),
  MOSAIC_INTAKE_SHARED_SECRET: optionalNonEmptyString(),
  MOSAIC_STAGED_ISSUE_SECRET: optionalNonEmptyString(),
  MOSAIC_FORM_EMBEDS: optionalNonEmptyString(),
  MOSAIC_TRIGGER_PHRASE: optionalNonEmptyString(),
  VERIFICATION_REQUIRE_SANDBOX: optionalBoolean(),
  MOSAIC_LLM_KEY: optionalNonEmptyString()
});

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | undefined;

export const feedbackSourceSchema = z.enum([
  "web_form",
  "email",
  "github_issue",
  "github_comment",
  "discord",
  "slack",
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

export const llmModelPresetSchema = z.enum(["quality", "balanced"]) satisfies z.ZodType<LLMModelPreset>;

export const llmModelPresetOptions = [
  {
    value: "quality",
    label: "Quality (Recommended)",
    description: "Uses automatic Haiku/Sonnet routing and enables the Opus advisor for complex work."
  },
  {
    value: "balanced",
    label: "Balanced",
    description: "Uses automatic Haiku/Sonnet routing and disables the advisor."
  }
] as const satisfies ReadonlyArray<{
  value: LLMModelPreset;
  label: string;
  description: string;
}>;

// Canonical repo security defaults. Keep config/default.config.yml, repo-config.ts,
// and config/mosaic.config.ts aligned to this object.
export const defaultSecurityConfig = {
  max_files_changed: 5,
  max_lines_added: 350,
  max_changed_lines: 500,
  block_patterns: ["eval(", "child_process", "exec(", "execSync", "Function("]
} as const;

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
    MOSAIC_TRIGGER_PHRASE: parsed.data.MOSAIC_TRIGGER_PHRASE ?? "@mosaic",
    DISCORD_ENABLE_MESSAGE_CONTENT_INTENT: parsed.data.DISCORD_ENABLE_MESSAGE_CONTENT_INTENT ?? false,
    VERIFICATION_REQUIRE_SANDBOX: parsed.data.VERIFICATION_REQUIRE_SANDBOX ?? (parsed.data.NODE_ENV === "production"),
    GITHUB_PRIVATE_KEY_PATH: resolveConfigPath(parsed.data.GITHUB_PRIVATE_KEY_PATH),
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

function resolveConfigPath(inputPath: string): string {
  if (inputPath.startsWith("~/")) {
    return resolve(homedir(), inputPath.slice(2));
  }

  if (inputPath.startsWith("/")) {
    return inputPath;
  }

  return resolve(workspaceRoot, inputPath);
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

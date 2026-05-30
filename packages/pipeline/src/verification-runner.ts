import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { exec as execCallback } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import type { GeneratedChange, RepoContext } from "@mosaic/core";

import type { ImplementationPlan } from "./implementation-planner.js";

const exec = promisify(execCallback);
const ignoredCopyNames = new Set([".git", "node_modules", "dist", "build", "__pycache__", ".next", "vendor"]);
const maxCommands = 3;
const defaultTimeoutMs = 120_000;

export interface VerificationResult {
  valid: boolean;
  commands: string[];
  errors: string[];
}

function hasShellMetacharacters(command: string): boolean {
  return /[;&|<>`$\\]/.test(command);
}

function isAllowedVerificationCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || hasShellMetacharacters(normalized)) {
    return false;
  }

  return /^(?:python3?|uv run python)\s+-m\s+unittest\b/.test(normalized) ||
    /^(?:python3?|uv run python)\s+-m\s+pytest\b/.test(normalized) ||
    /^pytest\b/.test(normalized) ||
    /^pnpm\s+(?:test|vitest)\b/.test(normalized) ||
    /^npm\s+test\b/.test(normalized) ||
    /^npx\s+vitest\b/.test(normalized);
}

function pythonModuleForPath(path: string): string {
  return path.replace(/\.py$/, "").replace(/\//g, ".");
}

function inferredChangedTestCommands(changes: GeneratedChange[]): string[] {
  const pythonModules = changes
    .map((change) => change.filePath)
    .filter((path) => path.startsWith("tests/") && path.endsWith(".py"))
    .map(pythonModuleForPath)
    .sort();

  return pythonModules.length > 0
    ? [`python3 -m unittest ${pythonModules.map((module) => JSON.stringify(module)).join(" ")}`]
    : [];
}

function collectVerificationCommands(changes: GeneratedChange[], implementationPlan?: ImplementationPlan): string[] {
  const plannedCommands = implementationPlan?.verificationCommands ?? [];
  const commands = [...plannedCommands, ...inferredChangedTestCommands(changes)]
    .map((command) => command.trim())
    .filter((command) => command.length > 0)
    .filter(isAllowedVerificationCommand);

  return [...new Set(commands)].slice(0, maxCommands);
}

async function writeChanges(repoPath: string, changes: GeneratedChange[]): Promise<void> {
  for (const change of changes) {
    const absolutePath = join(repoPath, change.filePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, change.modifiedContent, "utf8");
  }
}

function shouldCopyPath(sourcePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, sourcePath);
  if (relativePath.length === 0) {
    return true;
  }

  return !relativePath.split("/").some((part) => ignoredCopyNames.has(part));
}

function truncateOutput(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > 4_000 ? `${trimmed.slice(0, 4_000)}\n...[truncated]` : trimmed;
}

export async function runVerificationCommands(
  changes: GeneratedChange[],
  repoContext: RepoContext,
  implementationPlan?: ImplementationPlan
): Promise<VerificationResult> {
  const commands = collectVerificationCommands(changes, implementationPlan);
  if (commands.length === 0) {
    return {
      valid: true,
      commands: [],
      errors: []
    };
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "mosaic-verify-"));
  const tempRepo = join(tempRoot, "repo");
  const errors: string[] = [];

  try {
    await cp(repoContext.localPath, tempRepo, {
      recursive: true,
      filter: (sourcePath) => shouldCopyPath(sourcePath, repoContext.localPath)
    });
    await writeChanges(tempRepo, changes);

    for (const command of commands) {
      try {
        await exec(command, {
          cwd: tempRepo,
          timeout: defaultTimeoutMs,
          maxBuffer: 1024 * 1024 * 10,
          env: {
            ...process.env,
            PYTHONPATH: tempRepo
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stdout = typeof error === "object" && error && "stdout" in error ? String(error.stdout) : "";
        const stderr = typeof error === "object" && error && "stderr" in error ? String(error.stderr) : "";
        errors.push(`Command failed (${command}): ${truncateOutput([message, stdout, stderr].filter(Boolean).join("\n"))}`);
      }
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  return {
    valid: errors.length === 0,
    commands,
    errors
  };
}

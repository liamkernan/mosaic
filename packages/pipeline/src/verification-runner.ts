import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { exec as execCallback } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { JSDOM, VirtualConsole } from "jsdom";

import type { GeneratedChange, RepoContext } from "@mosaic/core";

import type { ImplementationPlan } from "./implementation-planner.js";

const exec = promisify(execCallback);
const ignoredCopyNames = new Set([".git", "node_modules", "dist", "build", "__pycache__", ".next", "vendor"]);
const maxCommands = 3;
const defaultTimeoutMs = 120_000;
const frontendFilePattern = /\.(?:html?|[cm]?jsx?|tsx?)$/i;

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

function shouldRunFrontendSmoke(changes: GeneratedChange[]): boolean {
  return changes.some((change) => frontendFilePattern.test(change.filePath));
}

async function readOptionalFile(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch(() => null);
}

async function runFrontendSmoke(tempRepo: string, changes: GeneratedChange[]): Promise<string[]> {
  if (!shouldRunFrontendSmoke(changes)) {
    return [];
  }

  const html = await readOptionalFile(join(tempRepo, "index.html"));
  if (!html) {
    return [];
  }

  const runtimeErrors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => runtimeErrors.push(error.message));
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
    virtualConsole
  });

  dom.window.console = {
    ...dom.window.console,
    error: (...args: unknown[]) => runtimeErrors.push(args.map(String).join(" "))
  };

  const scriptPaths = [...dom.window.document.querySelectorAll("script[src]")]
    .map((scriptElement) => scriptElement.getAttribute("src") ?? "")
    .filter((src) => src.length > 0 && !/^(?:[a-z]+:)?\/\//i.test(src))
    .map((src) => src.replace(/^\.\//, "").replace(/^\//, ""));

  try {
    for (const scriptPath of scriptPaths) {
      const script = await readOptionalFile(join(tempRepo, scriptPath));
      if (!script) {
        runtimeErrors.push(`Linked script could not be loaded: ${scriptPath}`);
        continue;
      }

      const scriptElement = dom.window.document.createElement("script");
      scriptElement.textContent = script;
      dom.window.document.body.appendChild(scriptElement);
    }
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  } finally {
    dom.window.close();
  }

  return runtimeErrors.map((error) => `Frontend runtime smoke failed: ${truncateOutput(error)}`);
}

export async function runVerificationCommands(
  changes: GeneratedChange[],
  repoContext: RepoContext,
  implementationPlan?: ImplementationPlan
): Promise<VerificationResult> {
  const commands = collectVerificationCommands(changes, implementationPlan);
  const runFrontend = shouldRunFrontendSmoke(changes);
  if (commands.length === 0 && !runFrontend) {
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

    errors.push(...await runFrontendSmoke(tempRepo, changes));

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

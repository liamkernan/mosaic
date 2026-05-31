import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import type { GeneratedChange, RepoContext } from "@mosaic/core";

import type { ImplementationPlan } from "./implementation-planner.js";

const ignoredCopyNames = new Set([".git", "node_modules", "dist", "build", "__pycache__", ".next", "vendor"]);
const maxCommands = 3;
const defaultTimeoutMs = 120_000;
const maxOutputBytes = 1024 * 1024 * 10;
const memoryLimitKb = 1024 * 1024;
const frontendFilePattern = /\.(?:html?|[cm]?jsx?|tsx?)$/i;
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const rootPackageJson = join(repoRoot, "package.json");

const frontendSmokeChildScript = `
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(process.argv[1]);
const { JSDOM, VirtualConsole } = require("jsdom");
const tempRepo = process.argv[2];

function truncateOutput(output) {
  const trimmed = output.trim();
  return trimmed.length > 4_000 ? \`\${trimmed.slice(0, 4_000)}\\n...[truncated]\` : trimmed;
}

async function readOptionalFile(path) {
  return readFile(path, "utf8").catch(() => null);
}

const html = await readOptionalFile(join(tempRepo, "index.html"));
const runtimeErrors = [];

function recordRuntimeError(message) {
  if (message.length > 0 && !runtimeErrors.includes(message)) {
    runtimeErrors.push(message);
  }
}

if (html) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => recordRuntimeError(error.message));
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
    virtualConsole
  });
  dom.window.addEventListener("error", (event) => {
    const message = event.error instanceof Error ? event.error.message : event.message;
    recordRuntimeError(message);
  });
  dom.window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    recordRuntimeError(reason instanceof Error ? reason.message : String(reason));
  });
  dom.window.console = {
    ...dom.window.console,
    error: (...args) => recordRuntimeError(args.map(String).join(" "))
  };

  const scriptPaths = [...dom.window.document.querySelectorAll("script[src]")]
    .map((scriptElement) => scriptElement.getAttribute("src") ?? "")
    .filter((src) => src.length > 0 && !/^(?:[a-z]+:)?\\/\\//i.test(src))
    .map((src) => src.replace(/^\\.\\//, "").replace(/^\\//, ""));

  try {
    for (const scriptPath of scriptPaths) {
      const script = await readOptionalFile(join(tempRepo, scriptPath));
      if (!script) {
        recordRuntimeError(\`Linked script could not be loaded: \${scriptPath}\`);
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
}

process.stdout.write(JSON.stringify(runtimeErrors.map((error) => \`Frontend runtime smoke failed: \${truncateOutput(error)}\`)));
`;

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

function unsupportedPlannedVerificationCommands(implementationPlan?: ImplementationPlan): string[] {
  return (implementationPlan?.verificationCommands ?? [])
    .map((command) => command.trim())
    .filter((command) => command.length > 0 && !isAllowedVerificationCommand(command));
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

function verificationEnv(tempRepo: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    PYTHONPATH: tempRepo
  };
}

function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (quote) {
    return null;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens.length > 0 ? tokens : null;
}

function networkSandboxArgs(executable: string, args: string[]): { executable: string; args: string[] } {
  if (process.platform === "darwin") {
    return {
      executable: "sandbox-exec",
      args: ["-p", "(version 1) (allow default) (deny network*)", executable, ...args]
    };
  }

  return { executable, args };
}

function limitedProcessArgs(executable: string, args: string[]): { executable: string; args: string[] } {
  if (process.platform === "win32") {
    return { executable, args };
  }

  return {
    executable: "/bin/sh",
    args: [
      "-c",
      `ulimit -t ${Math.ceil(defaultTimeoutMs / 1000)}; ulimit -v ${memoryLimitKb} 2>/dev/null || true; exec "$@"`,
      "mosaic-verify",
      executable,
      ...args
    ]
  };
}

async function runSandboxedProcess(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs = defaultTimeoutMs
): Promise<{ stdout: string; stderr: string }> {
  const limited = limitedProcessArgs(executable, args);
  const sandboxed = networkSandboxArgs(limited.executable, limited.args);

  return new Promise((resolve, reject) => {
    const child = spawn(sandboxed.executable, sandboxed.args, {
      cwd,
      detached: process.platform !== "win32",
      env: verificationEnv(cwd),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32" && child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    const collectOutput = (chunks: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes <= maxOutputBytes) {
        chunks.push(chunk);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => collectOutput(stdoutChunks, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collectOutput(stderrChunks, chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeoutMs}ms\n${stdout}\n${stderr}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Command exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}\n${stdout}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runFrontendSmoke(tempRepo: string, changes: GeneratedChange[]): Promise<string[]> {
  if (!shouldRunFrontendSmoke(changes)) {
    return [];
  }

  const html = await readOptionalFile(join(tempRepo, "index.html"));
  if (!html) {
    return [];
  }

  try {
    const { stdout } = await runSandboxedProcess(
      process.execPath,
      ["--max-old-space-size=256", "--input-type=module", "--eval", frontendSmokeChildScript, rootPackageJson, tempRepo],
      tempRepo
    );
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : ["Frontend runtime smoke failed: invalid smoke runner output"];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`Frontend runtime smoke failed: ${truncateOutput(message)}`];
  }
}

export async function runVerificationCommands(
  changes: GeneratedChange[],
  repoContext: RepoContext,
  implementationPlan?: ImplementationPlan
): Promise<VerificationResult> {
  const commands = collectVerificationCommands(changes, implementationPlan);
  const unsupportedCommands = unsupportedPlannedVerificationCommands(implementationPlan);
  const runFrontend = shouldRunFrontendSmoke(changes);
  if (commands.length === 0 && unsupportedCommands.length === 0 && !runFrontend) {
    return {
      valid: true,
      commands: [],
      errors: []
    };
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "mosaic-verify-"));
  const tempRepo = join(tempRoot, "repo");
  const errors: string[] = unsupportedCommands.map((command) => `Unsupported verification command was not run: ${command}`);

  try {
    await cp(repoContext.localPath, tempRepo, {
      recursive: true,
      filter: (sourcePath) => shouldCopyPath(sourcePath, repoContext.localPath)
    });
    await writeChanges(tempRepo, changes);

    errors.push(...await runFrontendSmoke(tempRepo, changes));

    for (const command of commands) {
      try {
        const tokens = tokenizeCommand(command);
        if (!tokens) {
          errors.push(`Unsupported verification command was not run: ${command}`);
          continue;
        }
        await runSandboxedProcess(tokens[0], tokens.slice(1), tempRepo);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Command failed (${command}): ${truncateOutput(message)}`);
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

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { getEnv, logger, type GeneratedChange, type RepoContext } from "@mosaic/core";

import type { ImplementationPlan } from "./implementation-planner.js";
import { resolveRepoWritePath } from "./repo-paths.js";

const ignoredCopyNames = new Set([
  ".env",
  ".git",
  ".next",
  ".pnpm-store",
  "node_modules",
  "dist",
  "build",
  "__pycache__",
  "private-key.pem",
  "vendor"
]);
const maxCommands = 3;
const defaultTimeoutMs = 120_000;
const maxOutputBytes = 1024 * 1024 * 10;
const defaultDockerImage = "mosaic-verify:local";
const dockerWorkdir = "/workspace";
const dockerSmokePackageJson = "/opt/mosaic-verify/package.json";
const frontendFilePattern = /\.(?:html?|[cm]?jsx?|tsx?)$/i;
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const rootPackageJson = join(repoRoot, "package.json");
let dockerAvailableCache: boolean | undefined;
const dockerImageReady = new Map<string, Promise<void>>();

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

export interface VerificationRunnerOptions {
  dockerAvailable?: boolean | (() => boolean | Promise<boolean>);
  requireSandbox?: boolean;
  dockerImage?: string;
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

function inferredChangedTestCommand(changes: GeneratedChange[]): string | undefined {
  const pythonModules: string[] = [];
  for (const change of changes) {
    if (change.filePath.startsWith("tests/") && change.filePath.endsWith(".py")) {
      pythonModules.push(pythonModuleForPath(change.filePath));
    }
  }

  if (pythonModules.length === 0) {
    return undefined;
  }

  pythonModules.sort();
  return `python3 -m unittest ${pythonModules.map((module) => JSON.stringify(module)).join(" ")}`;
}

function addVerificationCommand(commands: string[], seen: Set<string>, command: string): void {
  const trimmed = command.trim();
  if (trimmed.length === 0 || seen.has(trimmed) || !isAllowedVerificationCommand(trimmed)) {
    return;
  }

  seen.add(trimmed);
  commands.push(trimmed);
}

function collectVerificationCommands(changes: GeneratedChange[], implementationPlan?: ImplementationPlan): string[] {
  const commands: string[] = [];
  const seen = new Set<string>();

  for (const command of implementationPlan?.verificationCommands ?? []) {
    addVerificationCommand(commands, seen, command);
    if (commands.length >= maxCommands) {
      return commands;
    }
  }

  const inferredCommand = inferredChangedTestCommand(changes);
  if (inferredCommand) {
    addVerificationCommand(commands, seen, inferredCommand);
  }

  return commands;
}

function unsupportedPlannedVerificationCommands(implementationPlan?: ImplementationPlan): string[] {
  return (implementationPlan?.verificationCommands ?? [])
    .map((command) => command.trim())
    .filter((command) => command.length > 0 && !isAllowedVerificationCommand(command));
}

async function writeChanges(repoPath: string, changes: GeneratedChange[]): Promise<string[]> {
  const errors: string[] = [];

  for (const change of changes) {
    const resolvedPath = await resolveRepoWritePath(repoPath, change.filePath);
    if (!resolvedPath) {
      errors.push(`Unsafe generated change path rejected: ${change.filePath}`);
      continue;
    }

    const absolutePath = resolvedPath.absolutePath;
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, change.modifiedContent, "utf8");
  }

  return errors;
}

function shouldCopyPath(sourcePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, sourcePath);
  if (relativePath.length === 0) {
    return true;
  }

  const name = basename(sourcePath);
  if (name === ".env" || name.startsWith(".env.")) {
    return false;
  }

  const privateKeyPath = process.env.GITHUB_PRIVATE_KEY_PATH?.trim() || "private-key.pem";
  const resolvedPrivateKeyPath = privateKeyPath.startsWith("/") ? privateKeyPath : resolve(repoRoot, privateKeyPath);
  if (sourcePath === resolvedPrivateKeyPath) {
    return false;
  }

  return !relativePath.split(/[\\/]/).some((part) => ignoredCopyNames.has(part));
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
      `ulimit -t ${Math.ceil(defaultTimeoutMs / 1000)}; exec "$@"`,
      "mosaic-verify",
      executable,
      ...args
    ]
  };
}

async function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = defaultTimeoutMs,
  onTimeout?: () => Promise<void> | void
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      detached: process.platform !== "win32",
      env,
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

      void onTimeout?.();
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

async function runFallbackSandboxedProcess(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs = defaultTimeoutMs
): Promise<{ stdout: string; stderr: string }> {
  const limited = limitedProcessArgs(executable, args);
  const sandboxed = networkSandboxArgs(limited.executable, limited.args);

  return runProcess(sandboxed.executable, sandboxed.args, cwd, verificationEnv(cwd), timeoutMs);
}

function dockerEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  };
}

async function checkDockerAvailable(): Promise<boolean> {
  if (dockerAvailableCache !== undefined) {
    return dockerAvailableCache;
  }

  try {
    await runProcess("docker", ["info"], repoRoot, dockerEnv(), 10_000);
    dockerAvailableCache = true;
  } catch {
    dockerAvailableCache = false;
  }

  return dockerAvailableCache;
}

async function resolveDockerAvailable(options: VerificationRunnerOptions): Promise<boolean> {
  if (typeof options.dockerAvailable === "boolean") {
    return options.dockerAvailable;
  }

  if (typeof options.dockerAvailable === "function") {
    return await options.dockerAvailable();
  }

  return checkDockerAvailable();
}

function resolveRequireSandbox(options: VerificationRunnerOptions): boolean {
  return options.requireSandbox ?? getEnv().VERIFICATION_REQUIRE_SANDBOX ?? false;
}

async function ensureDockerImage(image: string): Promise<void> {
  const existing = dockerImageReady.get(image);
  if (existing) {
    return existing;
  }

  const ready = (async () => {
    try {
      await runProcess("docker", ["image", "inspect", image], repoRoot, dockerEnv(), 15_000);
      return;
    } catch {
      await runProcess("docker", ["build", "-f", "Dockerfile.verify", "-t", image, "."], repoRoot, dockerEnv(), 10 * 60_000);
    }
  })();

  dockerImageReady.set(image, ready);

  try {
    await ready;
  } catch (error) {
    dockerImageReady.delete(image);
    throw error;
  }
}

function dockerRunArgs(image: string, tempRepo: string, executable: string, args: string[], containerName: string): string[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;

  return [
    "run",
    "--name",
    containerName,
    "--rm",
    "--network=none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m",
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    `${uid}:${gid}`,
    "--memory",
    "1g",
    "--cpus",
    "1",
    "--pids-limit",
    "128",
    "--workdir",
    dockerWorkdir,
    "--env",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "--env",
    `PYTHONPATH=${dockerWorkdir}`,
    "--env",
    "HOME=/tmp",
    "--mount",
    `type=bind,source=${tempRepo},target=${dockerWorkdir},readonly=false`,
    image,
    executable,
    ...args
  ];
}

async function runDockerSandboxedProcess(
  image: string,
  executable: string,
  args: string[],
  tempRepo: string,
  timeoutMs = defaultTimeoutMs
): Promise<{ stdout: string; stderr: string }> {
  const containerName = `mosaic-verify-${process.pid}-${Date.now()}-${randomUUID()}`;
  return runProcess("docker", dockerRunArgs(image, tempRepo, executable, args, containerName), repoRoot, dockerEnv(), timeoutMs, async () => {
    await runProcess("docker", ["rm", "-f", containerName], repoRoot, dockerEnv(), 15_000).catch(() => undefined);
  });
}

type VerificationExecutor = (executable: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

async function runFrontendSmoke(
  tempRepo: string,
  changes: GeneratedChange[],
  executor: VerificationExecutor,
  smokeExecutable: string,
  smokePackageJson: string,
  smokeRepoPath: string
): Promise<string[]> {
  if (!shouldRunFrontendSmoke(changes)) {
    return [];
  }

  const html = await readOptionalFile(join(tempRepo, "index.html"));
  if (!html) {
    return [];
  }

  try {
    const { stdout } = await executor(
      smokeExecutable,
      ["--max-old-space-size=256", "--input-type=module", "--eval", frontendSmokeChildScript, smokePackageJson, smokeRepoPath],
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
  implementationPlan?: ImplementationPlan,
  options: VerificationRunnerOptions = {}
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

  if (commands.length === 0 && unsupportedCommands.length > 0 && !runFrontend) {
    return {
      valid: false,
      commands,
      errors: unsupportedCommands.map((command) => `Unsupported verification command was not run: ${command}`)
    };
  }

  const dockerAvailable = await resolveDockerAvailable(options);
  const requireSandbox = resolveRequireSandbox(options);
  if (!dockerAvailable && requireSandbox) {
    return {
      valid: false,
      commands,
      errors: [
        ...unsupportedCommands.map((command) => `Unsupported verification command was not run: ${command}`),
        "Verification isolation unavailable: Docker sandbox is required but Docker is not available"
      ]
    };
  }

  const dockerImage = options.dockerImage ?? defaultDockerImage;
  const executor: VerificationExecutor = dockerAvailable
    ? (executable, args, cwd) => runDockerSandboxedProcess(dockerImage, executable, args, cwd)
    : runFallbackSandboxedProcess;
  const smokeExecutable = dockerAvailable ? "node" : process.execPath;
  const smokePackageJson = dockerAvailable ? dockerSmokePackageJson : rootPackageJson;

  if (dockerAvailable) {
    await ensureDockerImage(dockerImage);
  } else {
    logger.warn({ repo: repoContext.fullName }, "Verification running with degraded isolation because Docker is unavailable");
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "mosaic-verify-"));
  const tempRepo = join(tempRoot, "repo");
  const smokeRepoPath = dockerAvailable ? dockerWorkdir : tempRepo;
  const errors: string[] = unsupportedCommands.map((command) => `Unsupported verification command was not run: ${command}`);

  try {
    await cp(repoContext.localPath, tempRepo, {
      recursive: true,
      filter: (sourcePath) => shouldCopyPath(sourcePath, repoContext.localPath)
    });
    const writeErrors = await writeChanges(tempRepo, changes);
    errors.push(...writeErrors);
    if (writeErrors.length > 0) {
      return {
        valid: false,
        commands,
        errors
      };
    }

    errors.push(...await runFrontendSmoke(tempRepo, changes, executor, smokeExecutable, smokePackageJson, smokeRepoPath));

    for (const command of commands) {
      try {
        const tokens = tokenizeCommand(command);
        if (!tokens) {
          errors.push(`Unsupported verification command was not run: ${command}`);
          continue;
        }
        await executor(tokens[0], tokens.slice(1), tempRepo);
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

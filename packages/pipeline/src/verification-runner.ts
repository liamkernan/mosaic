import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { getEnv, logger, type GeneratedChange, type RepoContext } from "@mosaic/core";

import type { ImplementationPlan } from "./implementation-planner.js";
import { normalizeRepoRelativePath, resolveRepoWritePath } from "./repo-paths.js";

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
const frontendSmokeMetadataFile = ".mosaic-frontend-smoke.json";
const frontendFilePattern = /\.(?:html?|[cm]?jsx?|tsx?)$/i;
const testDirectoryPattern = /(?:^|\/)(?:test|tests|spec|specs|__tests__|reported)(?:\/|$)/i;
const testSupportDirectoryPattern =
  /(?:^|\/)(?:fixtures?|helpers?|support|__mocks__|__snapshots__)(?:\/|$)/i;
const testSupportFilePattern =
  /(?:^|\/)(?:conftest|fixtures?|helpers?|setup|__init__)\.(?:py|rb|[cm]?[jt]sx?)$/i;
const javascriptTestFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const javascriptSourceFilePattern = /\.[cm]?[jt]sx?$/i;
const pythonTestFilePattern = /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/i;
const supportedTestSourceFilePattern = /\.(?:py|rb|go|rs|java|kt|php|cs|swift|[cm]?[jt]sx?)$/i;
const conventionalTestFilePattern =
  /(?:^|\/)(?:test_[^/]+|[^/]+_(?:test|spec)|[^/]+\.(?:test|spec))\.(?:py|rb|go|rs|java|kt|php|cs|swift|[cm]?[jt]sx?)$/i;
const capitalizedTestFilePattern = /(?:^|\/)[^/]+(?:Test|Tests|Spec|Specs)\.(?:java|kt|php|cs|swift)$/;
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
const metadataFile = ".mosaic-frontend-smoke.json";

function truncateOutput(output) {
  const trimmed = output.trim();
  return trimmed.length > 4_000 ? \`\${trimmed.slice(0, 4_000)}\\n...[truncated]\` : trimmed;
}

async function readOptionalFile(path) {
  return readFile(path, "utf8").catch(() => null);
}

const html = await readOptionalFile(join(tempRepo, "index.html"));
const runtimeErrors = [];
const interactionErrors = [];

function recordRuntimeError(message) {
  if (message.length > 0 && !runtimeErrors.includes(message)) {
    runtimeErrors.push(message);
  }
}

function normalizedText(value) {
  return String(value ?? "").replace(/\\s+/g, " ").trim();
}

function controlLabel(element) {
  const labels = "labels" in element && element.labels
    ? [...element.labels].map((label) => normalizedText(label.textContent)).filter(Boolean)
    : [];
  return labels.join(" ");
}

function controlIdentity(element) {
  const tag = element.tagName.toLowerCase();
  const type = normalizedText(element.getAttribute("type")).toLowerCase();
  const id = normalizedText(element.id);
  const name = normalizedText(element.getAttribute("name"));
  const value = normalizedText(element.getAttribute("value"));
  const ariaLabel = normalizedText(element.getAttribute("aria-label"));
  const label = controlLabel(element);
  const text = normalizedText(element.textContent);
  return [tag, type, id, name, value, ariaLabel, label, text].join("|");
}

function describeControl(element) {
  const tag = element.tagName.toLowerCase();
  const type = normalizedText(element.getAttribute("type"));
  const id = normalizedText(element.id);
  const name = normalizedText(element.getAttribute("name"));
  const label = controlLabel(element) || normalizedText(element.getAttribute("aria-label")) || normalizedText(element.textContent);
  const attributes = [
    type ? ' type="' + type + '"' : "",
    id ? ' id="' + id + '"' : "",
    name ? ' name="' + name + '"' : ""
  ].join("");
  return "<" + tag + attributes + ">" + (label ? ' labeled "' + label + '"' : "");
}

function isBehavioralControl(element) {
  const hint = [
    element.id,
    element.getAttribute("name"),
    element.getAttribute("aria-label"),
    controlLabel(element),
    element.textContent
  ].map(normalizedText).join(" ");
  return /(?:filter|view|search|sort)/i.test(hint);
}

function observableSnapshot(window) {
  return JSON.stringify({
    href: window.location.href,
    markup: window.document.documentElement.innerHTML
  });
}

async function exerciseControl(window, element) {
  if (element.disabled) {
    return false;
  }

  const tag = element.tagName.toLowerCase();
  const type = normalizedText(element.getAttribute("type")).toLowerCase();

  if (tag === "select") {
    if (element.options.length < 2) {
      return false;
    }
    element.selectedIndex = element.selectedIndex === 0 ? 1 : 0;
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  } else if (tag === "input" && type === "radio") {
    if (element.checked) {
      return false;
    }
    element.click();
  } else if (tag === "input" && type === "checkbox") {
    element.click();
  } else if (tag === "input" && (type === "search" || type === "text" || type === "")) {
    element.value = element.value ? element.value + " mosaic-smoke" : "mosaic-smoke";
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  } else if (tag === "button" || (tag === "input" && (type === "button" || type === "submit"))) {
    element.click();
  } else {
    return false;
  }

  await new Promise((resolve) => window.setTimeout(resolve, 0));
  return true;
}

if (html) {
  const metadataText = await readOptionalFile(join(tempRepo, metadataFile));
  let originalHtml = null;
  if (metadataText) {
    try {
      const metadata = JSON.parse(metadataText);
      originalHtml = typeof metadata.originalHtml === "string" ? metadata.originalHtml : null;
    } catch {
      recordRuntimeError("Frontend smoke metadata could not be parsed");
    }
  }

  const controlSelector = "button, input, select";
  const addedControlIdentities = new Set();
  if (originalHtml !== null) {
    const originalStaticDom = new JSDOM(originalHtml);
    const currentStaticDom = new JSDOM(html);
    const originalIdentities = new Set(
      [...originalStaticDom.window.document.querySelectorAll(controlSelector)].map(controlIdentity)
    );
    for (const element of currentStaticDom.window.document.querySelectorAll(controlSelector)) {
      const identity = controlIdentity(element);
      if (!originalIdentities.has(identity)) {
        addedControlIdentities.add(identity);
      }
    }
    originalStaticDom.window.close();
    currentStaticDom.window.close();
  }

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

    if (addedControlIdentities.size > 0) {
      const addedControls = [...dom.window.document.querySelectorAll(controlSelector)]
        .filter((element) => addedControlIdentities.has(controlIdentity(element)))
        .filter(isBehavioralControl);

      for (const control of addedControls) {
        const before = observableSnapshot(dom.window);
        let exercised = false;
        try {
          exercised = await exerciseControl(dom.window, control);
        } catch (error) {
          recordRuntimeError(error instanceof Error ? error.message : String(error));
        }
        if (exercised && observableSnapshot(dom.window) === before) {
          interactionErrors.push(
            describeControl(control) + " did not produce an observable page or URL change when exercised"
          );
        }
      }
    }
  } finally {
    dom.window.close();
  }
}

process.stdout.write(JSON.stringify([
  ...runtimeErrors.map((error) => \`Frontend runtime smoke failed: \${truncateOutput(error)}\`),
  ...interactionErrors.map((error) => \`Frontend interaction smoke failed: \${truncateOutput(error)}\`)
]));
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

function hasUnsafePathArgument(command: string): boolean {
  const tokens = tokenizeCommand(command);
  if (!tokens) {
    return true;
  }

  return tokens.slice(1).some((token) => {
    const equalsIndex = token.indexOf("=");
    const value = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : token;
    return value.startsWith("/") ||
      /^[a-zA-Z]:\//.test(value) ||
      value.split("/").includes("..");
  });
}

function isSafeNodeTestCommand(command: string): boolean {
  const tokens = tokenizeCommand(command);
  if (!tokens || tokens.length < 3 || tokens[0] !== "node" || tokens[1] !== "--test") {
    return false;
  }

  return tokens.slice(2).every((path) =>
    !path.startsWith("-") &&
    normalizeRepoRelativePath(path) !== null
  );
}

function isAllowedVerificationCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (
    normalized.length === 0 ||
    hasShellMetacharacters(normalized) ||
    hasUnsafePathArgument(normalized)
  ) {
    return false;
  }

  return /^(?:python3?|uv run python)\s+-m\s+unittest\b/.test(normalized) ||
    /^(?:python3?|uv run python)\s+-m\s+pytest\b/.test(normalized) ||
    /^pytest\b/.test(normalized) ||
    isSafeNodeTestCommand(normalized) ||
    /^pnpm\s+(?:test|vitest)\b/.test(normalized) ||
    /^npm\s+test\b/.test(normalized) ||
    /^npx\s+vitest\b/.test(normalized);
}

function pythonModuleForPath(path: string): string {
  return path.replace(/\.py$/, "").replace(/\//g, ".");
}

interface InferredTestCommand {
  path: string;
  command?: string;
  runner: "pytest" | "unittest" | "node-test" | "unsupported";
}

interface CollectedVerificationCommands {
  commands: string[];
  generatedTestPathsByCommand: Map<string, string[]>;
  unverifiedChangedTestPaths: string[];
  omittedPlannedVerificationCommands: string[];
}

function isPytestStyle(change: GeneratedChange): boolean {
  return /(?:^|\n)\s*(?:from\s+pytest\b|import\s+pytest\b)|\bpytest\.|^(?:async\s+)?def\s+test_/m
    .test(change.modifiedContent);
}

function normalizeTestPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function isChangedTestPath(path: string): boolean {
  const normalized = normalizeTestPath(path);
  const explicitTestFilename = javascriptTestFilePattern.test(normalized) ||
    pythonTestFilePattern.test(normalized) ||
    conventionalTestFilePattern.test(normalized) ||
    capitalizedTestFilePattern.test(normalized);
  if (explicitTestFilename) {
    return true;
  }

  return testDirectoryPattern.test(normalized) &&
    supportedTestSourceFilePattern.test(normalized) &&
    !testSupportDirectoryPattern.test(normalized) &&
    !testSupportFilePattern.test(normalized);
}

function changedTestPaths(changes: GeneratedChange[]): string[] {
  return [...new Set(changes
    .map((change) => normalizeTestPath(change.filePath))
    .filter(isChangedTestPath))]
    .sort();
}

function isNodeTestStyle(change: GeneratedChange): boolean {
  return /\bfrom\s+["']node:test["']|\brequire\(\s*["']node:test["']\s*\)|\bimport\s+["']node:test["']/
    .test(change.modifiedContent);
}

function inferredChangedTestCommandRecords(changes: GeneratedChange[]): InferredTestCommand[] {
  const records: InferredTestCommand[] = [];
  const seenPaths = new Set<string>();
  for (const change of changes) {
    const filePath = normalizeRepoRelativePath(change.filePath);
    if (!filePath || !isChangedTestPath(filePath) || seenPaths.has(filePath)) {
      continue;
    }
    seenPaths.add(filePath);

    if (filePath.endsWith(".py")) {
      const pytest = isPytestStyle(change);
      records.push({
        path: filePath,
        command: pytest
          ? `python3 -m pytest ${JSON.stringify(filePath)}`
          : `python3 -m unittest ${JSON.stringify(pythonModuleForPath(filePath))}`,
        runner: pytest ? "pytest" : "unittest"
      });
      continue;
    }

    if (javascriptSourceFilePattern.test(filePath) && isNodeTestStyle(change)) {
      records.push({
        path: filePath,
        command: `node --test ${JSON.stringify(filePath)}`,
        runner: "node-test"
      });
      continue;
    }

    records.push({
      path: filePath,
      runner: "unsupported"
    });
  }

  const runnerOrder: Record<InferredTestCommand["runner"], number> = {
    pytest: 0,
    unittest: 1,
    "node-test": 2,
    unsupported: 3
  };
  return records.sort((left, right) =>
    runnerOrder[left.runner] - runnerOrder[right.runner] ||
    left.path.localeCompare(right.path)
  );
}

export function inferredChangedTestCommands(changes: GeneratedChange[]): string[] {
  return inferredChangedTestCommandRecords(changes)
    .flatMap(({ command }) => command ? [command] : []);
}

function addVerificationCommand(commands: string[], seen: Set<string>, command: string): string | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0 || seen.has(trimmed) || !isAllowedVerificationCommand(trimmed)) {
    return undefined;
  }

  seen.add(trimmed);
  commands.push(trimmed);
  return trimmed;
}

function collectVerificationCommands(
  changes: GeneratedChange[],
  implementationPlan?: ImplementationPlan
): CollectedVerificationCommands {
  const commands: string[] = [];
  const seen = new Set<string>();
  const coveredChangedTestPaths = new Set<string>();
  const generatedTestPathsByCommand = new Map<string, string[]>();
  const allChangedTestPaths = changedTestPaths(changes);
  const plannedCommands = (implementationPlan?.verificationCommands ?? [])
    .map((command) => command.trim())
    .filter((command) => isAllowedVerificationCommand(command));
  const inferredRecords = inferredChangedTestCommandRecords(changes);

  for (const record of inferredRecords) {
    if (!record.command || commands.length >= maxCommands) {
      continue;
    }
    const added = addVerificationCommand(commands, seen, record.command);
    if (added) {
      generatedTestPathsByCommand.set(added, [record.path]);
      coveredChangedTestPaths.add(record.path);
    }
  }

  for (const command of plannedCommands) {
    if (commands.length >= maxCommands) {
      continue;
    }
    addVerificationCommand(commands, seen, command);
  }

  return {
    commands,
    generatedTestPathsByCommand,
    unverifiedChangedTestPaths: allChangedTestPaths.filter((path) => !coveredChangedTestPaths.has(path)),
    omittedPlannedVerificationCommands: plannedCommands.filter((command) => !seen.has(command))
  };
}

function unsupportedPlannedVerificationCommands(implementationPlan?: ImplementationPlan): string[] {
  const commands = implementationPlan?.verificationCommands;
  if (!commands) {
    return [];
  }

  const unsupported: string[] = [];
  for (const command of commands) {
    const trimmed = command.trim();
    if (trimmed.length > 0 && !isAllowedVerificationCommand(trimmed)) {
      unsupported.push(trimmed);
    }
  }

  return unsupported;
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

function conciseGeneratedTestOutput(output: string, tempRepo: string): string {
  const scrubbed = output
    .replaceAll(tempRepo, "<repo>")
    .replaceAll(dockerWorkdir, "<repo>")
    .trim();
  return scrubbed.length > 2_000 ? `${scrubbed.slice(0, 2_000)}\n...[truncated]` : scrubbed;
}

function generatedTestNonExecutionReason(output: string): string | undefined {
  if (/\bRan 0 tests?\b|\bcollected 0 items?\b|\bno tests ran\b|(?:^|\n)#?\s*tests?\s+0\b/i.test(output)) {
    return "the runner reported zero executed tests";
  }

  const unittestCount = output.match(/\bRan (\d+) tests?\b/i);
  const unittestSkipped = output.match(/\bskipped=(\d+)\b/i);
  if (unittestCount && unittestSkipped && Number(unittestCount[1]) === Number(unittestSkipped[1])) {
    return "the runner skipped every selected test";
  }
  if (/\b\d+ skipped\b/i.test(output) && !/\b\d+ passed\b/i.test(output)) {
    return "the runner skipped every selected test";
  }

  const nodeSummaryCount = (label: string): number | undefined => {
    const match = output.match(new RegExp(`(?:^|\\n)#\\s*${label}\\s+(\\d+)\\s*(?:\\n|$)`, "i"));
    return match ? Number(match[1]) : undefined;
  };
  const nodeTests = nodeSummaryCount("tests?");
  const nodePassed = nodeSummaryCount("pass") ?? 0;
  const nodeSkipped = nodeSummaryCount("skipped") ?? 0;
  const nodeTodo = nodeSummaryCount("todo") ?? 0;
  const nodeCancelled = nodeSummaryCount("cancelled") ?? 0;
  if (
    nodeTests !== undefined &&
    nodeTests > 0 &&
    nodePassed === 0 &&
    nodeSkipped + nodeTodo + nodeCancelled >= nodeTests
  ) {
    return "the runner skipped or deferred every selected test";
  }

  return undefined;
}

function generatedTestLabel(paths: string[]): string {
  return paths.join(", ");
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

  const indexChange = changes.find((change) => change.filePath.replace(/^\.\//, "") === "index.html");
  if (indexChange) {
    await writeFile(
      join(tempRepo, frontendSmokeMetadataFile),
      JSON.stringify({ originalHtml: indexChange.originalContent }),
      "utf8"
    );
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
  const collectedCommands = collectVerificationCommands(changes, implementationPlan);
  const {
    commands,
    generatedTestPathsByCommand,
    unverifiedChangedTestPaths,
    omittedPlannedVerificationCommands
  } = collectedCommands;
  const unsupportedCommands = unsupportedPlannedVerificationCommands(implementationPlan);
  const preflightErrors = [
    ...unsupportedCommands.map((command) => `Unsupported verification command was not run: ${command}`),
    ...omittedPlannedVerificationCommands.map((command) =>
      `Safe verification command was not run because the ${maxCommands}-command limit was reached: ${command}`
    ),
    ...unverifiedChangedTestPaths.map((path) =>
      `Changed test was not mapped to a safe independent verification command: ${path}`
    )
  ];
  const runFrontend = shouldRunFrontendSmoke(changes);
  if (commands.length === 0 && preflightErrors.length === 0 && !runFrontend) {
    return {
      valid: true,
      commands: [],
      errors: []
    };
  }

  if (commands.length === 0 && preflightErrors.length > 0 && !runFrontend) {
    return {
      valid: false,
      commands,
      errors: preflightErrors
    };
  }

  const dockerAvailable = await resolveDockerAvailable(options);
  const requireSandbox = resolveRequireSandbox(options);
  if (!dockerAvailable && requireSandbox) {
    return {
      valid: false,
      commands,
      errors: [
        ...preflightErrors,
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
  const errors: string[] = [...preflightErrors];

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
        const completed = await executor(tokens[0], tokens.slice(1), tempRepo);
        const generatedTestPaths = generatedTestPathsByCommand.get(command);
        if (generatedTestPaths) {
          const output = `${completed.stdout}\n${completed.stderr}`;
          const nonExecutionReason = generatedTestNonExecutionReason(output);
          if (nonExecutionReason) {
            errors.push(
              `Generated test did not execute independently (${generatedTestLabel(generatedTestPaths)}): ${nonExecutionReason}`
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const generatedTestPaths = generatedTestPathsByCommand.get(command);
        const nonExecutionReason = generatedTestPaths
          ? generatedTestNonExecutionReason(message)
          : undefined;
        errors.push(generatedTestPaths
          ? nonExecutionReason
            ? `Generated test did not execute independently (${generatedTestLabel(generatedTestPaths)}): ${nonExecutionReason}`
            : `Generated test failed independently (${generatedTestLabel(generatedTestPaths)}): ${conciseGeneratedTestOutput(message, tempRepo)}`
          : `Command failed (${command}): ${truncateOutput(message)}`);
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

import { exec as execCallback } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { JSDOM, VirtualConsole } from "jsdom";

import { CodeGenerator } from "../packages/pipeline/src/code-generator.js";
import { FeedbackClassifier } from "../packages/pipeline/src/classifier.js";
import { ImplementationPlanner, type ImplementationPlan } from "../packages/pipeline/src/implementation-planner.js";
import { validatePlanCompletion } from "../packages/pipeline/src/plan-completion-validator.js";
import { RepoIndexer } from "../packages/pipeline/src/repo-indexer.js";
import { validate } from "../packages/pipeline/src/validator.js";
import { applyValidationFallbacks } from "../packages/pipeline/src/validation-repair.js";
import { getEnv } from "../packages/core/src/config.js";
import type { ClassifiedFeedback, ComplexityLevel, FeedbackCategory, FeedbackSource, FileNode, GeneratedChange, RepoContext } from "../packages/core/src/types.js";
import { ANTHROPIC_MODEL_IDS, LLMClient } from "../packages/llm/src/client.js";

const exec = promisify(execCallback);
const ignoredNames = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".next", "vendor"]);
const validationRepairAttempts = 2;

interface EvalCase {
  id: string;
  repoFullName: string;
  repoDirName: string;
  baseRef: string;
  issueNumber?: number;
  feedback: {
    source: FeedbackSource;
    rawContent: string;
    senderIdentifier: string;
    category: FeedbackCategory;
    complexity: ComplexityLevel;
    summary: string;
    relevantFiles: string[];
    confidence: number;
  };
  expectedReferenceFiles?: string[];
  requiredChangedFilePatterns?: Array<string | string[]>;
  requiredFileContains?: Array<{ path: string | string[]; text: string }>;
  verificationCommands?: string[];
  runPythonUnitTests?: boolean;
  runChangedPythonTests?: boolean;
  frontendAssertions?: FrontendAssertion[];
}

interface FrontendAssertion {
  name: string;
  click: string | string[];
  expect: Array<
    | { selector: string | string[]; textIncludes: string }
    | { selector: string | string[]; attribute: string; equals: string }
    | { selector: string | string[]; hasClass: string | string[] }
    | { selector: string | string[]; minCount: number }
  >;
}

interface EvalResult {
  id: string;
  passed: boolean;
  tempPath: string;
  generated: boolean;
  references: string[];
  loadedFiles: string[];
  changedFiles: string[];
  errors: string[];
}

function parseArgs(argv: string[]): {
  caseIds: string[];
  generate: boolean;
  classify: boolean;
  keep: boolean;
  repoRoot: string;
  casesPath: string;
  model: keyof typeof ANTHROPIC_MODEL_IDS;
  caseTimeoutMs: number;
} {
  const args = {
    caseIds: [] as string[],
    generate: false,
    classify: false,
    keep: false,
    repoRoot: process.env.MOSAIC_EVAL_REPO_ROOT ?? resolve(process.env.HOME ?? ".", "Documents"),
    casesPath: "evals/local-fix-cases.json",
    model: "sonnet" as keyof typeof ANTHROPIC_MODEL_IDS,
    caseTimeoutMs: Number(process.env.MOSAIC_EVAL_CASE_TIMEOUT_MS ?? 300_000)
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--generate") {
      args.generate = true;
    } else if (arg === "--classify") {
      args.classify = true;
    } else if (arg === "--keep") {
      args.keep = true;
    } else if (arg === "--case") {
      args.caseIds.push(argv[++index]);
    } else if (arg === "--repo-root") {
      args.repoRoot = argv[++index];
    } else if (arg === "--cases") {
      args.casesPath = argv[++index];
    } else if (arg === "--model") {
      const model = argv[++index] as keyof typeof ANTHROPIC_MODEL_IDS;
      if (!(model in ANTHROPIC_MODEL_IDS)) {
        throw new Error(`Unknown model tier: ${model}`);
      }
      args.model = model;
    } else if (arg === "--case-timeout-ms") {
      args.caseTimeoutMs = Number(argv[++index]);
      if (!Number.isFinite(args.caseTimeoutMs) || args.caseTimeoutMs <= 0) {
        throw new Error("--case-timeout-ms must be a positive number");
      }
    } else if (arg === "--") {
      continue;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function detectLanguage(filePath: string): string | undefined {
  const extension = filePath.split(".").pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    yml: "yaml",
    yaml: "yaml",
    py: "python"
  };

  return extension ? languageMap[extension] : undefined;
}

async function buildFileTree(rootPath: string, currentPath = ""): Promise<FileNode[]> {
  const directoryPath = currentPath ? join(rootPath, currentPath) : rootPath;
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const nodes: FileNode[] = [];

  for (const entry of entries) {
    if (ignoredNames.has(entry.name) || entry.name.startsWith(".")) {
      continue;
    }

    const relativePath = currentPath ? join(currentPath, entry.name) : entry.name;
    const absolutePath = join(rootPath, relativePath);

    if (entry.isDirectory()) {
      nodes.push({
        path: relativePath,
        type: "directory",
        children: await buildFileTree(rootPath, relativePath)
      });
      continue;
    }

    const fileStat = await stat(absolutePath);
    nodes.push({
      path: relativePath,
      type: "file",
      language: detectLanguage(relativePath),
      sizeBytes: fileStat.size
    });
  }

  return nodes.sort((left, right) => left.path.localeCompare(right.path));
}

async function copyRepoAtRef(sourceRepo: string, baseRef: string): Promise<string> {
  const tempPath = await mkdtemp(join(tmpdir(), "mosaic-eval-"));
  const archivePath = join(tempPath, "repo.tar");
  const worktreePath = join(tempPath, "repo");
  await mkdir(worktreePath);
  await exec(`git archive --format=tar --output ${JSON.stringify(archivePath)} ${JSON.stringify(baseRef)}`, { cwd: sourceRepo });
  await exec(`tar -xf ${JSON.stringify(archivePath)} -C ${JSON.stringify(worktreePath)}`);
  return worktreePath;
}

function createEvalLlmClient(model: keyof typeof ANTHROPIC_MODEL_IDS): LLMClient {
  const env = getEnv();
  return new LLMClient({
    mode: "platform",
    platformApiKey: env.ANTHROPIC_API_KEY,
    model: ANTHROPIC_MODEL_IDS[model],
    disableUsageTracking: true
  });
}

function mergeFiles<T extends { path: string }>(left: T[], right: T[]): T[] {
  const merged = new Map(left.map((file) => [file.path, file]));
  for (const file of right) {
    merged.set(file.path, file);
  }
  return [...merged.values()];
}

async function writeGeneratedChanges(repoPath: string, changes: GeneratedChange[]): Promise<void> {
  for (const change of changes) {
    const absolutePath = join(repoPath, change.filePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, change.modifiedContent, "utf8");
  }
}

async function findPythonTestModules(repoPath: string, currentPath = "tests"): Promise<string[]> {
  const absolutePath = join(repoPath, currentPath);
  const exists = await stat(absolutePath).then(() => true, () => false);
  if (!exists) {
    return [];
  }

  const entries = await readdir(absolutePath, { withFileTypes: true });
  const modules: string[] = [];
  for (const entry of entries) {
    const relativePath = join(currentPath, entry.name);
    if (entry.isDirectory()) {
      modules.push(...await findPythonTestModules(repoPath, relativePath));
    } else if (entry.isFile() && entry.name.endsWith(".py") && entry.name !== "__init__.py") {
      modules.push(relativePath.replace(/\.py$/, "").replace(/\//g, "."));
    }
  }

  return modules.sort();
}

async function runCommand(command: string, cwd: string): Promise<void> {
  await exec(command, {
    cwd,
    maxBuffer: 1024 * 1024 * 10,
    env: {
      ...process.env,
      PYTHONPATH: cwd
    }
  });
}

async function runVerification(evalCase: EvalCase, repoPath: string, changes: GeneratedChange[]): Promise<string[]> {
  const errors: string[] = [];

  for (const command of evalCase.verificationCommands ?? []) {
    try {
      await runCommand(command, repoPath);
    } catch (error) {
      errors.push(`Verification command failed (${command}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (evalCase.runPythonUnitTests) {
    const modules = await findPythonTestModules(repoPath);
    if (modules.length === 0) {
      errors.push("No Python unit test modules found under tests/");
    } else {
      const command = `python3 -m unittest ${modules.map((module) => JSON.stringify(module)).join(" ")}`;
      try {
        await runCommand(command, repoPath);
      } catch (error) {
        errors.push(`Python unittest verification failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (evalCase.runChangedPythonTests) {
    const modules = changes
      .map((change) => change.filePath)
      .filter((path) => path.startsWith("tests/") && path.endsWith(".py"))
      .map((path) => path.replace(/\.py$/, "").replace(/\//g, "."))
      .sort();

    if (modules.length === 0) {
      errors.push("No changed Python test modules found under tests/");
    } else {
      const command = `python3 -m unittest ${modules.map((module) => JSON.stringify(module)).join(" ")}`;
      try {
        await runCommand(command, repoPath);
      } catch (error) {
        errors.push(`Changed Python test verification failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return errors;
}

async function evaluateChecks(
  evalCase: EvalCase,
  repoPath: string,
  references: string[],
  loadedFiles: string[],
  changes: GeneratedChange[],
  generated: boolean
): Promise<string[]> {
  const errors: string[] = [];
  const changedFiles = new Set(changes.map((change) => change.filePath));

  for (const expectedPath of evalCase.expectedReferenceFiles ?? []) {
    if (!references.includes(expectedPath) && !loadedFiles.includes(expectedPath)) {
      errors.push(`Expected context file was not loaded: ${expectedPath}`);
    }
  }

  if (generated) {
    for (const pattern of evalCase.requiredChangedFilePatterns ?? []) {
      const patterns = Array.isArray(pattern) ? pattern : [pattern];
      const matched = [...changedFiles].some((filePath) =>
        patterns.some((candidate) => filePath === candidate || filePath.includes(candidate))
      );
      if (!matched) {
        errors.push(`No generated change matched required path pattern: ${patterns.join(" OR ")}`);
      }
    }

    for (const requirement of evalCase.requiredFileContains ?? []) {
      const paths = Array.isArray(requirement.path) ? requirement.path : [requirement.path];
      const matched = await Promise.all(paths.map(async (path) => {
        const content = await readFile(join(repoPath, path), "utf8").catch(() => "");
        return content.includes(requirement.text);
      }));
      if (!matched.some(Boolean)) {
        errors.push(`${paths.join(" OR ")} does not contain required text: ${requirement.text}`);
      }
    }

    for (const error of await runFrontendAssertions(evalCase, repoPath)) {
      errors.push(error);
    }
  }

  return errors;
}

function isTextExpectation(expectation: FrontendAssertion["expect"][number]): expectation is { selector: string | string[]; textIncludes: string } {
  return "textIncludes" in expectation;
}

function isAttributeExpectation(expectation: FrontendAssertion["expect"][number]): expectation is { selector: string | string[]; attribute: string; equals: string } {
  return "attribute" in expectation;
}

function isClassExpectation(expectation: FrontendAssertion["expect"][number]): expectation is { selector: string | string[]; hasClass: string | string[] } {
  return "hasClass" in expectation;
}

function isCountExpectation(expectation: FrontendAssertion["expect"][number]): expectation is { selector: string | string[]; minCount: number } {
  return "minCount" in expectation;
}

function selectorLabel(selector: string | string[]): string {
  return Array.isArray(selector) ? selector.join(" OR ") : selector;
}

function querySelector(document: Document, selector: string | string[]): Element | null {
  const selectors = Array.isArray(selector) ? selector : [selector];
  for (const candidate of selectors) {
    const element = document.querySelector(candidate);
    if (element) {
      return element;
    }
  }

  return null;
}

function querySelectorAll(document: Document, selector: string | string[]): Element[] {
  const selectors = Array.isArray(selector) ? selector : [selector];
  const elements = new Set<Element>();
  for (const candidate of selectors) {
    document.querySelectorAll(candidate).forEach((element) => elements.add(element));
  }

  return [...elements];
}

function hasExpectedClass(element: Element, className: string | string[]): boolean {
  const classNames = Array.isArray(className) ? className : [className];
  return classNames.some((candidate) => element.classList.contains(candidate));
}

async function runFrontendAssertions(evalCase: EvalCase, repoPath: string): Promise<string[]> {
  if (!evalCase.frontendAssertions || evalCase.frontendAssertions.length === 0) {
    return [];
  }

  const html = await readFile(join(repoPath, "index.html"), "utf8").catch(() => "");
  if (html.length === 0) {
    return ["Frontend assertions require index.html"];
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

  if (scriptPaths.length === 0) {
    return ["Frontend assertions require at least one local linked script"];
  }

  const errors: string[] = [];
  for (const scriptPath of scriptPaths) {
    const script = await readFile(join(repoPath, scriptPath), "utf8").catch(() => "");
    if (script.length === 0) {
      errors.push(`Linked script could not be loaded: ${scriptPath}`);
      continue;
    }

    const scriptElement = dom.window.document.createElement("script");
    scriptElement.textContent = script;
    dom.window.document.body.appendChild(scriptElement);
  }
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

  for (const assertion of evalCase.frontendAssertions) {
    try {
      const clickable = querySelector(dom.window.document, assertion.click);
      if (!clickable) {
        errors.push(`${assertion.name}: click target not found: ${selectorLabel(assertion.click)}`);
        continue;
      }

      clickable.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

      for (const expectation of assertion.expect) {
        const elements = querySelectorAll(dom.window.document, expectation.selector);
        if (isCountExpectation(expectation)) {
          if (elements.length < expectation.minCount) {
            errors.push(`${assertion.name}: expected at least ${expectation.minCount} matches for ${selectorLabel(expectation.selector)}, found ${elements.length}`);
          }
          continue;
        }

        const element = elements[0];
        if (!element) {
          errors.push(`${assertion.name}: expected element not found: ${selectorLabel(expectation.selector)}`);
          continue;
        }

        if (isTextExpectation(expectation)) {
          const text = element.textContent ?? "";
          if (!text.includes(expectation.textIncludes)) {
            errors.push(`${assertion.name}: ${selectorLabel(expectation.selector)} text did not include ${JSON.stringify(expectation.textIncludes)}`);
          }
        } else if (isAttributeExpectation(expectation)) {
          const actual = element.getAttribute(expectation.attribute);
          if (actual !== expectation.equals) {
            errors.push(`${assertion.name}: ${selectorLabel(expectation.selector)} expected ${expectation.attribute}=${JSON.stringify(expectation.equals)}, got ${JSON.stringify(actual)}`);
          }
        } else if (isClassExpectation(expectation) && !hasExpectedClass(element, expectation.hasClass)) {
          errors.push(`${assertion.name}: ${selectorLabel(expectation.selector)} missing class ${selectorLabel(expectation.hasClass)}`);
        }
      }
    } catch (error) {
      errors.push(`${assertion.name}: frontend assertion crashed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (runtimeErrors.length > 0) {
    errors.push(`Frontend runtime errors: ${runtimeErrors.join("; ")}`);
  }

  dom.window.close();
  return errors;
}

async function runCase(evalCase: EvalCase, options: ReturnType<typeof parseArgs>): Promise<EvalResult> {
  const sourceRepo = resolve(options.repoRoot, evalCase.repoDirName);
  const repoPath = await copyRepoAtRef(sourceRepo, evalCase.baseRef);
  const repoIndexer = new RepoIndexer();
  const repoContext: RepoContext = {
    fullName: evalCase.repoFullName,
    defaultBranch: "main",
    localPath: repoPath,
    fileTree: await buildFileTree(repoPath),
    installationId: 0
  };

  let classifiedFeedback: ClassifiedFeedback = {
    id: evalCase.id,
    repoFullName: evalCase.repoFullName,
    receivedAt: new Date(),
    metadata: {},
    ...evalCase.feedback
  };

  if (options.classify) {
    const classifier = new FeedbackClassifier(createEvalLlmClient("haiku"));
    classifiedFeedback = await classifier.classify(classifiedFeedback, repoIndexer.fileTreeToPaths(repoContext));
  }

  let relevantFiles = await repoIndexer.findRelevantFiles(repoContext, classifiedFeedback);
  const referenceFiles = await repoIndexer.findRepositoryReferenceFiles(repoContext, classifiedFeedback, {
    issueNumber: evalCase.issueNumber
  });
  relevantFiles = mergeFiles(relevantFiles, referenceFiles);

  let changes: GeneratedChange[] = [];
  let generated = false;
  const errors: string[] = [];

  if (options.generate) {
    generated = true;
    const fileTree = repoIndexer.fileTreeToPaths(repoContext);
    const planner = new ImplementationPlanner(createEvalLlmClient(options.model));
    const implementationPlan = await planner.plan(classifiedFeedback, relevantFiles, fileTree);
    const plannedFiles = await repoIndexer.readFiles(repoContext, implementationPlan.requiredFiles);
    relevantFiles = mergeFiles(relevantFiles, plannedFiles);
    const generator = new CodeGenerator(createEvalLlmClient(options.model));
    changes = await generateValidatedChanges(generator, classifiedFeedback, relevantFiles, fileTree, implementationPlan, repoContext);
    await writeGeneratedChanges(repoPath, changes);
    repoContext.fileTree = await buildFileTree(repoPath);
    let verificationErrors = await runVerification(evalCase, repoPath, changes);
    if (verificationErrors.length > 0) {
      const repairedChanges = await repairVerificationFailure(
        generator,
        classifiedFeedback,
        relevantFiles,
        fileTree,
        implementationPlan,
        repoContext,
        changes,
        verificationErrors
      );
      if (repairedChanges.length > 0) {
        changes = repairedChanges;
        await writeGeneratedChanges(repoPath, changes);
        repoContext.fileTree = await buildFileTree(repoPath);
        verificationErrors = await runVerification(evalCase, repoPath, changes);
      }
    }
    errors.push(...verificationErrors);
  }

  let checkErrors = await evaluateChecks(
    evalCase,
    repoPath,
    referenceFiles.map((file) => file.path),
    relevantFiles.map((file) => file.path),
    changes,
    generated
  );

  if (options.generate && checkErrors.length > 0) {
    const fileTree = repoIndexer.fileTreeToPaths(repoContext);
    const planner = new ImplementationPlanner(createEvalLlmClient(options.model));
    const implementationPlan = await planner.plan(classifiedFeedback, relevantFiles, fileTree);
    const generator = new CodeGenerator(createEvalLlmClient(options.model));
    const repairedChanges = await repairVerificationFailure(
      generator,
      classifiedFeedback,
      relevantFiles,
      fileTree,
      implementationPlan,
      repoContext,
      changes,
      checkErrors
    );
    if (repairedChanges.length > 0) {
      changes = repairedChanges;
      await writeGeneratedChanges(repoPath, changes);
      repoContext.fileTree = await buildFileTree(repoPath);
      const repairedVerificationErrors = await runVerification(evalCase, repoPath, changes);
      errors.push(...repairedVerificationErrors);
      checkErrors = repairedVerificationErrors.length > 0
        ? checkErrors
        : await evaluateChecks(
            evalCase,
            repoPath,
            referenceFiles.map((file) => file.path),
            relevantFiles.map((file) => file.path),
            changes,
            generated
          );
    }
  }

  errors.push(...checkErrors);

  return {
    id: evalCase.id,
    passed: errors.length === 0,
    tempPath: repoPath,
    generated,
    references: referenceFiles.map((file) => file.path),
    loadedFiles: relevantFiles.map((file) => file.path),
    changedFiles: changes.map((change) => change.filePath),
    errors
  };
}

async function generateValidatedChanges(
  generator: CodeGenerator,
  feedback: ClassifiedFeedback,
  relevantFiles: Array<{ path: string; content: string; reason: string }>,
  fileTree: string[],
  implementationPlan: ImplementationPlan,
  repoContext: RepoContext
): Promise<GeneratedChange[]> {
  let changes = await generator.generate(feedback, relevantFiles, fileTree, implementationPlan, {
    completeSolution: true
  });
  let validation = await validate(changes, repoContext);
  const planErrors = validatePlanCompletion(changes, implementationPlan);
  if (planErrors.length > 0) {
    validation = {
      valid: false,
      errors: [...validation.errors, ...planErrors]
    };
  }

  for (let attempt = 0; !validation.valid && attempt < validationRepairAttempts; attempt += 1) {
    try {
      const repairedChanges = await generator.repairValidationFailure(
        feedback,
        relevantFiles,
        fileTree,
        changes,
        validation.errors,
        implementationPlan,
        {
          completeSolution: true
        }
      );
      if (repairedChanges.length > 0) {
        changes = repairedChanges;
        validation = await validate(changes, repoContext);
        const repairedPlanErrors = validatePlanCompletion(changes, implementationPlan);
        if (repairedPlanErrors.length > 0) {
          validation = {
            valid: false,
            errors: [...validation.errors, ...repairedPlanErrors]
          };
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (!message.includes("llm") && !message.includes("anthropic") && !message.includes("timed out") && !message.includes("timeout")) {
        throw error;
      }
      break;
    }
  }

  if (!validation.valid) {
    const completedChanges = await applyValidationFallbacks(changes, repoContext, validation.errors);
    if (completedChanges !== changes) {
      changes = completedChanges;
      validation = await validate(changes, repoContext);
      const completedPlanErrors = validatePlanCompletion(changes, implementationPlan);
      if (completedPlanErrors.length > 0) {
        validation = {
          valid: false,
          errors: [...validation.errors, ...completedPlanErrors]
        };
      }
    }
  }

  if (!validation.valid) {
    throw new Error(`Generated changes failed validation: ${validation.errors.join("; ")}`);
  }

  return changes;
}

async function repairVerificationFailure(
  generator: CodeGenerator,
  feedback: ClassifiedFeedback,
  relevantFiles: Array<{ path: string; content: string; reason: string }>,
  fileTree: string[],
  implementationPlan: ImplementationPlan,
  repoContext: RepoContext,
  currentChanges: GeneratedChange[],
  verificationErrors: string[]
): Promise<GeneratedChange[]> {
  const repairedChanges = await generator.repairValidationFailure(
    feedback,
    relevantFiles,
    fileTree,
    currentChanges,
    verificationErrors.map((error) => `Verification failed: ${error}`),
    implementationPlan,
    {
      completeSolution: true
    }
  );

  if (repairedChanges.length === 0) {
    return [];
  }

  let validation = await validate(repairedChanges, repoContext);
  const planErrors = validatePlanCompletion(repairedChanges, implementationPlan);
  if (planErrors.length > 0) {
    validation = {
      valid: false,
      errors: [...validation.errors, ...planErrors]
    };
  }

  if (!validation.valid) {
    const completedChanges = await applyValidationFallbacks(repairedChanges, repoContext, validation.errors);
    if (completedChanges !== repairedChanges) {
      validation = await validate(completedChanges, repoContext);
      const completedPlanErrors = validatePlanCompletion(completedChanges, implementationPlan);
      if (completedPlanErrors.length > 0) {
        validation = {
          valid: false,
          errors: [...validation.errors, ...completedPlanErrors]
        };
      }

      if (validation.valid) {
        return completedChanges;
      }
    }
  }

  if (!validation.valid) {
    throw new Error(`Verification repair failed static validation: ${validation.errors.join("; ")}`);
  }

  return repairedChanges;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cases = JSON.parse(await readFile(options.casesPath, "utf8")) as EvalCase[];
  const selectedCases = options.caseIds.length > 0
    ? cases.filter((evalCase) => options.caseIds.includes(evalCase.id))
    : cases;

  if (selectedCases.length === 0) {
    throw new Error("No eval cases selected");
  }

  const results: EvalResult[] = [];
  for (const evalCase of selectedCases) {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      console.error(`Eval case timed out after ${options.caseTimeoutMs}ms: ${evalCase.id}`);
      process.exit(124);
    }, options.caseTimeoutMs);

    try {
      const result = await runCase(evalCase, options);
      results.push(result);
      if (!options.keep) {
        await rm(dirname(result.tempPath), { recursive: true, force: true });
      }
    } finally {
      if (!timedOut) {
        clearTimeout(timeout);
      }
    }
  }

  const passed = results.filter((result) => result.passed).length;
  for (const result of results) {
    const status = result.passed ? "PASS" : "FAIL";
    console.log(`${status} ${result.id}`);
    console.log(`  references: ${result.references.join(", ") || "(none)"}`);
    console.log(`  loaded: ${result.loadedFiles.join(", ") || "(none)"}`);
    if (result.generated) {
      console.log(`  changed: ${result.changedFiles.join(", ") || "(none)"}`);
    }
    if (result.errors.length > 0) {
      for (const error of result.errors) {
        console.log(`  - ${error}`);
      }
    }
    if (options.keep) {
      console.log(`  temp: ${result.tempPath}`);
    }
  }

  console.log(`\n${passed}/${results.length} evals passed`);
  if (passed !== results.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

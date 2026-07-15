import { exec as execCallback, execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { JSDOM, VirtualConsole } from "jsdom";

import { CodeGenerator, scopeValidationPattern } from "../packages/pipeline/src/code-generator.js";
import { mergeGeneratedChanges } from "../packages/pipeline/src/change-set.js";
import { FeedbackClassifier } from "../packages/pipeline/src/classifier.js";
import {
  classifyFeedbackWithOpenAIRouting,
  type OpenAIClassificationPass
} from "../packages/pipeline/src/classification-routing.js";
import { ImplementationPlanner, type ImplementationPlan } from "../packages/pipeline/src/implementation-planner.js";
import { pruneChangesToPlanScope, validatePlanCompletion } from "../packages/pipeline/src/plan-completion-validator.js";
import { assessRepairProgress, findUnplannedAddedFiles } from "../packages/pipeline/src/repair-progress.js";
import { RepoIndexer } from "../packages/pipeline/src/repo-indexer.js";
import { validate } from "../packages/pipeline/src/validator.js";
import { applyValidationFallbacks, applyVerificationFallbacks } from "../packages/pipeline/src/validation-repair.js";
import { getEnv } from "../packages/core/src/config.js";
import { LLMError } from "../packages/core/src/errors.js";
import type { ClassifiedFeedback, ComplexityLevel, FeedbackCategory, FeedbackSource, FileNode, GeneratedChange, LLMProvider, RepoContext } from "../packages/core/src/types.js";
import { assessFeedbackContent, type AbuseAssessment } from "../packages/intake/src/abuse-protection.js";
import {
  LLMClient,
  type LLMRequestAuthorization,
  type LLMUsageIteration,
  type LLMUsageObservation,
  type OpenAIReasoningEffort
} from "../packages/llm/src/client.js";
import { resolveOpenAIBaseURL } from "../packages/llm/src/openai.js";
import {
  defaultEvalModelKey,
  isEvalModelKey,
  resolveEvalLlmRoutes,
  validateExpectedOpenAIRoute,
  type EvalClientRoute,
  type EvalModelKey,
  type ExpectedOpenAIRoute
} from "./eval-llm-routing.js";
import {
  EvalBudget,
  EvalCaseExecutionError,
  DEFAULT_EVAL_CASE_TIMEOUT_MS,
  assessRawSolutionOutcome,
  assertGeneratedPathsAllowed,
  buildChangedPythonTestCommand,
  calculateUsageCostUsd,
  calculateUsageIterationsCostUsd,
  captureFrontendElementOpenState,
  createEvalTrialRuns,
  estimateMaximumAdvisorCallCostUsd,
  estimateMaximumCallCostUsd,
  formatFrontendRepairRequirement,
  frontendElementHasDialogSemantics,
  frontendElementIsOpen,
  inferChangedPythonTestRunner,
  partitionVisibleContext,
  partitionVerificationCommands,
  relocateGeneratedTestsFromImmutablePaths,
  runEvalCaseBatch,
  sanitizePlanForImmutablePaths,
  summarizeEvalTrials,
  summarizeRepairAttempts,
  validateAllowedChangedPaths,
  writeCaseArtifacts,
  writeJsonAtomically,
  writeEvalReport,
  resolveCommittedEvalCostUsd,
  type EvalBudgetSnapshot,
  type EvalBatchResult,
  type EvalTrialRun,
  type EvalRepairSummary,
  type FrontendRepairRequirement,
  type ModelPricing,
  type RawSolutionFailureSurface,
  validateUnchangedSymbols,
  validateUnchangedSymbolsWithAllowedLines
} from "./eval-local-fixes-support.js";

const exec = promisify(execCallback);
const execFile = promisify(execFileCallback);
const ignoredNames = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".next", "vendor"]);
const validationRecoveryAttempts = 3;
const oversizedPatchPattern = /too large|exceeds limit|total new code added/i;

function isRecoverableLlmFailure(error: unknown): boolean {
  const maybeError = error as { code?: unknown; name?: unknown; message?: unknown };
  const message = typeof maybeError.message === "string" ? maybeError.message.toLowerCase() : String(error).toLowerCase();
  return error instanceof LLMError ||
    maybeError.code === "LLM_ERROR" ||
    maybeError.name === "LLMError" ||
    message.includes("llm") ||
    message.includes("anthropic") ||
    message.includes("timed out") ||
    message.includes("timeout");
}

interface EvalCase {
  id: string;
  repoFullName: string;
  repoDirName?: string;
  baseRef?: string;
  fixturePath?: string;
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
  allowedChangedFilePatterns?: Array<string | string[]>;
  requiredFileContains?: Array<{ path: string | string[]; text: string }>;
  verificationCommands?: string[];
  runPythonUnitTests?: boolean;
  runChangedPythonTests?: boolean;
  runChangedPytestTests?: boolean;
  pytestCommand?: string;
  frontendAssertions?: FrontendAssertion[];
  oracleTestPaths?: string[];
  oracleTestPathPrefixes?: string[];
  generatedTestPathPrefixes?: string[];
  unchangedPythonSymbols?: Record<string, string[]>;
  unchangedSymbols?: Record<string, string[]>;
  allowedSymbolAdditions?: Record<string, Record<string, string[]>>;
  expectedSafetyOutcome?: "accepted" | "rejected";
  expectedOpenAIRoute?: ExpectedOpenAIRoute;
}

interface FrontendAssertion {
  name: string;
  click: string | string[];
  expect: Array<
    | { selector: string | string[]; textIncludes: string }
    | { selector: string | string[]; attribute: string; equals: string }
    | { selector: string | string[]; hasClass: string | string[] }
    | { selector: string | string[]; minCount: number }
    | { selector: string | string[]; open: boolean }
    | { selector: string | string[]; dialog: true }
  >;
}

interface EvalResult {
  id: string;
  caseId: string;
  trial: number;
  passed: boolean;
  tempPath: string;
  generated: boolean;
  references: string[];
  loadedFiles: string[];
  changedFiles: string[];
  errors: string[];
  artifactPath: string;
  usage?: EvalUsageSummary;
  scopeViolations?: string[];
  routes?: ReturnType<typeof resolveEvalLlmRoutes>;
  safetyAssessment?: AbuseAssessment;
  repairAttempts?: EvalRepairSummary;
  classificationPasses?: OpenAIClassificationPass[];
  routePassed?: boolean;
  rawSolutionPassed?: boolean;
  finalSolutionPassed?: boolean;
  repairAssistedPassed?: boolean;
  rawFailureSurface?: RawSolutionFailureSurface;
}

interface EvalUsageCall extends Omit<LLMUsageObservation, "iterations"> {
  phase: string;
  costUsd: number;
  iterations: Array<LLMUsageIteration & { costUsd: number }>;
}

interface EvalUsageSummary extends EvalBudgetSnapshot {
  calls: EvalUsageCall[];
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadInputTokens: number;
  totalCacheCreationInputTokens: number;
  totalLatencyMs: number;
  totalRetries: number;
  totalCostUsd: number;
}

function emptyEvalUsageSummary(): EvalUsageSummary {
  return {
    calls: [],
    callCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadInputTokens: 0,
    totalCacheCreationInputTokens: 0,
    totalLatencyMs: 0,
    totalRetries: 0,
    totalCostUsd: 0,
    observedCostUsd: 0,
    outstandingReservedCostUsd: 0,
    committedCostUsd: 0,
    reservations: []
  };
}

type PricingTable = Record<string, ModelPricing>;

interface EvalTelemetry {
  authorize: (request: LLMRequestAuthorization) => Promise<string>;
  observe: (phase: string, event: LLMUsageObservation) => Promise<void>;
  snapshot: () => EvalUsageSummary;
}

function parseArgs(argv: string[]): {
  caseIds: string[];
  generate: boolean;
  classify: boolean;
  frozenEvaluation: boolean;
  keep: boolean;
  repoRoot: string;
  casesPath: string;
  provider: LLMProvider;
  model: EvalModelKey;
  modelOverrideProvided: boolean;
  caseTimeoutMs: number;
  outputDir: string;
  internalCase?: string;
  resultPath?: string;
  maxCostUsd?: number;
  pricingPath?: string;
  preset: "direct" | "balanced" | "quality";
  trials: number;
  trial: number;
  runId?: string;
} {
  const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const args = {
    caseIds: [] as string[],
    generate: false,
    classify: false,
    frozenEvaluation: false,
    keep: false,
    repoRoot: process.env.MOSAIC_EVAL_REPO_ROOT ?? resolve(process.env.HOME ?? ".", "Documents"),
    casesPath: "evals/local-fix-cases.json",
    provider: "anthropic" as LLMProvider,
    model: undefined as EvalModelKey | undefined,
    modelOverrideProvided: false,
    caseTimeoutMs: Number(process.env.MOSAIC_EVAL_CASE_TIMEOUT_MS ?? DEFAULT_EVAL_CASE_TIMEOUT_MS),
    outputDir: resolve(process.env.MOSAIC_EVAL_OUTPUT_DIR ?? join("evals", "runs", runTimestamp)),
    internalCase: undefined as string | undefined,
    resultPath: undefined as string | undefined,
    maxCostUsd: undefined as number | undefined,
    pricingPath: undefined as string | undefined,
    preset: "direct" as "direct" | "balanced" | "quality",
    trials: 1,
    trial: 1,
    runId: undefined as string | undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--generate") {
      args.generate = true;
    } else if (arg === "--classify") {
      args.classify = true;
    } else if (arg === "--frozen-evaluation") {
      args.frozenEvaluation = true;
    } else if (arg === "--keep") {
      args.keep = true;
    } else if (arg === "--case") {
      args.caseIds.push(argv[++index]);
    } else if (arg === "--repo-root") {
      args.repoRoot = argv[++index];
    } else if (arg === "--cases") {
      args.casesPath = argv[++index];
    } else if (arg === "--provider") {
      const provider = argv[++index];
      if (provider !== "anthropic" && provider !== "openai") {
        throw new Error("--provider must be anthropic or openai");
      }
      args.provider = provider;
    } else if (arg === "--model") {
      args.model = argv[++index] as EvalModelKey;
      args.modelOverrideProvided = true;
    } else if (arg === "--case-timeout-ms") {
      args.caseTimeoutMs = Number(argv[++index]);
      if (!Number.isFinite(args.caseTimeoutMs) || args.caseTimeoutMs <= 0) {
        throw new Error("--case-timeout-ms must be a positive number");
      }
    } else if (arg === "--output-dir") {
      args.outputDir = resolve(argv[++index]);
    } else if (arg === "--internal-case") {
      args.internalCase = argv[++index];
    } else if (arg === "--result-path") {
      args.resultPath = resolve(argv[++index]);
    } else if (arg === "--max-cost-usd") {
      args.maxCostUsd = Number(argv[++index]);
      if (!Number.isFinite(args.maxCostUsd) || args.maxCostUsd < 0) {
        throw new Error("--max-cost-usd must be a non-negative number");
      }
    } else if (arg === "--pricing") {
      args.pricingPath = resolve(argv[++index]);
    } else if (arg === "--preset") {
      const preset = argv[++index];
      if (preset !== "direct" && preset !== "balanced" && preset !== "quality") {
        throw new Error("--preset must be direct, balanced, or quality");
      }
      args.preset = preset;
    } else if (arg === "--trials") {
      args.trials = Number(argv[++index]);
      if (!Number.isSafeInteger(args.trials) || args.trials <= 0) {
        throw new Error("--trials must be a positive integer");
      }
    } else if (arg === "--trial") {
      args.trial = Number(argv[++index]);
      if (!Number.isSafeInteger(args.trial) || args.trial <= 0) {
        throw new Error("--trial must be a positive integer");
      }
    } else if (arg === "--run-id") {
      args.runId = argv[++index];
      if (!args.runId) {
        throw new Error("--run-id must not be empty");
      }
    } else if (arg === "--") {
      continue;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const model = args.model ?? defaultEvalModelKey(args.provider);
  if (!isEvalModelKey(args.provider, model)) {
    throw new Error(`Unknown ${args.provider} model tier: ${model}`);
  }

  return { ...args, model };
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

async function copyFixtureSource(sourcePath: string): Promise<string> {
  const tempPath = await mkdtemp(join(tmpdir(), "mosaic-eval-"));
  const worktreePath = join(tempPath, "repo");
  await cp(sourcePath, worktreePath, { recursive: true, force: false });
  return worktreePath;
}

function createEvalLlmClient(
  provider: LLMProvider,
  route: EvalClientRoute,
  telemetry?: EvalTelemetry,
  phase = "unspecified"
): LLMClient {
  const env = getEnv();
  const isOpenAI = provider === "openai";
  return new LLMClient({
    provider,
    mode: "platform",
    platformApiKey: isOpenAI ? env.AZURE_OPENAI_API_KEY ?? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY,
    openAIBaseURL: isOpenAI ? resolveOpenAIBaseURL(env.OPENAI_BASE_URL, env.AZURE_OPENAI_ENDPOINT) : undefined,
    openAIMinOutputTokens: isOpenAI ? env.MOSAIC_OPENAI_MIN_OUTPUT_TOKENS : undefined,
    openAIMinTimeoutMs: isOpenAI ? env.MOSAIC_OPENAI_MIN_TIMEOUT_MS : undefined,
    model: isOpenAI ? env.MOSAIC_OPENAI_MODEL ?? route.model : route.model,
    reasoningEffort: isOpenAI ? env.MOSAIC_OPENAI_REASONING_EFFORT ?? route.reasoningEffort : route.reasoningEffort,
    advisorTool: route.advisorTool,
    disableUsageTracking: true,
    authorizeRequest: telemetry?.authorize,
    observeUsage: telemetry ? (event) => telemetry.observe(phase, event) : undefined
  });
}

async function createEvalTelemetry(
  options: ReturnType<typeof parseArgs>,
  artifactPath: string
): Promise<EvalTelemetry | undefined> {
  if (!options.generate && !options.classify) {
    return undefined;
  }
  if (options.maxCostUsd === undefined || !options.pricingPath) {
    throw new Error("Paid evaluation requires both --max-cost-usd and --pricing");
  }

  const pricing = JSON.parse(await readFile(options.pricingPath, "utf8")) as PricingTable;
  const budget = new EvalBudget(options.maxCostUsd);
  const calls: EvalUsageCall[] = [];
  let writeQueue = Promise.resolve();

  const snapshot = (): EvalUsageSummary => {
    const observedUsage = calls.reduce<EvalUsageSummary>((summary, call) => ({
      ...summary,
      calls,
      callCount: summary.callCount + 1,
      totalInputTokens: summary.totalInputTokens + call.iterations.reduce((total, iteration) => total + iteration.inputTokens, 0),
      totalOutputTokens: summary.totalOutputTokens + call.iterations.reduce((total, iteration) => total + iteration.outputTokens, 0),
      totalCacheReadInputTokens: summary.totalCacheReadInputTokens + call.iterations.reduce((total, iteration) => total + iteration.cacheReadInputTokens, 0),
      totalCacheCreationInputTokens: summary.totalCacheCreationInputTokens + call.iterations.reduce((total, iteration) => total + iteration.cacheCreationInputTokens, 0),
      totalLatencyMs: summary.totalLatencyMs + call.latencyMs,
      totalRetries: summary.totalRetries + call.retries,
      totalCostUsd: summary.totalCostUsd + call.costUsd
    }), emptyEvalUsageSummary());
    return {
      ...observedUsage,
      ...budget.snapshot(),
      totalCostUsd: budget.totalCostUsd
    };
  };

  const persistUsage = async (): Promise<void> => {
    const usageSnapshot = snapshot();
    writeQueue = writeQueue.then(async () => {
      await mkdir(artifactPath, { recursive: true });
      await writeJsonAtomically(join(artifactPath, "usage.json"), usageSnapshot);
    });
    await writeQueue;
  };

  return {
    authorize: async (request) => {
      const modelPricing = pricing[request.model];
      if (!modelPricing) {
        throw new Error(`Missing pricing for model: ${request.model}`);
      }
      let estimatedMaxCostUsd = estimateMaximumCallCostUsd(
        request.estimatedInputTokens,
        request.maxOutputTokens,
        modelPricing
      );
      if (request.advisorModel) {
        const advisorPricing = pricing[request.advisorModel];
        if (!advisorPricing) {
          throw new Error(`Missing pricing for advisor model: ${request.advisorModel}`);
        }
        estimatedMaxCostUsd += estimateMaximumAdvisorCallCostUsd(
          request.estimatedInputTokens,
          request.maxOutputTokens,
          request.advisorMaxTokens ?? request.maxOutputTokens,
          advisorPricing
        );
      }
      const reservationId = budget.authorize({ estimatedMaxCostUsd });
      await persistUsage();
      return reservationId;
    },
    observe: async (phase, event) => {
      const costUsd = calculateUsageIterationsCostUsd(event.iterations, pricing);
      const iterations = event.iterations.map((iteration) => ({
        ...iteration,
        costUsd: calculateUsageCostUsd(iteration, pricing[iteration.model])
      }));
      budget.record({ ...event, costUsd }, event.authorizationId);
      calls.push({ ...event, iterations, phase, costUsd });
      await persistUsage();
    },
    snapshot
  };
}

function mergeFiles<T extends { path: string }>(left: T[], right: T[]): T[] {
  const merged = new Map(left.map((file) => [file.path, file]));
  for (const file of right) {
    merged.set(file.path, file);
  }
  return [...merged.values()];
}

function visibleFileTreePaths(repoIndexer: RepoIndexer, repoContext: RepoContext, evalCase: EvalCase): string[] {
  return partitionVisibleContext(
    repoIndexer.fileTreeToPaths(repoContext).map((path) => ({ path })),
    evalCase.oracleTestPaths ?? [],
    evalCase.oracleTestPathPrefixes ?? []
  ).visible.map(({ path }) => path);
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

async function runCommand(command: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return await exec(command, {
    cwd,
    maxBuffer: 1024 * 1024 * 10,
    env: {
      ...process.env,
      PYTHONPATH: cwd
    }
  });
}

type EvalVerificationScope = "visible" | "oracle";

function conciseGeneratedTestFailure(error: unknown, repoPath: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const scrubbed = message.replaceAll(repoPath, "<repo>").trim();
  return scrubbed.length > 2_000 ? `${scrubbed.slice(0, 2_000)}\n...[truncated]` : scrubbed;
}

function generatedTestNonExecutionReason(output: string): string | undefined {
  if (/\bRan 0 tests?\b|\bcollected 0 items?\b|\bno tests ran\b/i.test(output)) {
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
  return undefined;
}

async function runVerification(
  evalCase: EvalCase,
  repoPath: string,
  changes: GeneratedChange[],
  options: { scope?: EvalVerificationScope; runChangedTests?: boolean } = {}
): Promise<string[]> {
  const errors: string[] = [];
  const scope = options.scope ?? "visible";
  const partitionedCommands = partitionVerificationCommands(
    evalCase.verificationCommands ?? [],
    evalCase.oracleTestPaths ?? [],
    evalCase.oracleTestPathPrefixes ?? []
  );
  const verificationCommands = scope === "oracle"
    ? partitionedCommands.oracles
    : partitionedCommands.visible;

  for (const command of verificationCommands) {
    try {
      await runCommand(command, repoPath);
    } catch (error) {
      errors.push(`Verification command failed (${command}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (scope === "visible" && evalCase.runPythonUnitTests) {
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

  const inferredRunner = scope === "visible" && options.runChangedTests !== false
    ? inferChangedPythonTestRunner(changes, verificationCommands)
    : undefined;
  const changedTestRunner = evalCase.runChangedPytestTests
    ? "pytest"
    : evalCase.runChangedPythonTests
      ? "unittest"
      : inferredRunner;
  if (scope === "visible" && options.runChangedTests !== false && changedTestRunner) {
    const matchingPytestCommand = verificationCommands.find((command) => /\bpytest\b/.test(command));
    const configuredPytestCommand = evalCase.pytestCommand && partitionVerificationCommands(
      [evalCase.pytestCommand],
      evalCase.oracleTestPaths ?? [],
      evalCase.oracleTestPathPrefixes ?? []
    ).visible[0];
    const command = buildChangedPythonTestCommand(
      changes.map((change) => change.filePath),
      {
        runner: changedTestRunner,
        pytestCommand: configuredPytestCommand ?? matchingPytestCommand
      }
    );

    if (!command) {
      errors.push("No changed Python test modules found under tests/");
    } else {
      try {
        const completed = await runCommand(command, repoPath);
        const nonExecutionReason = generatedTestNonExecutionReason(`${completed.stdout}\n${completed.stderr}`);
        if (nonExecutionReason) {
          const paths = changes
            .map((change) => change.filePath)
            .filter((path) => path.startsWith("tests/") && path.endsWith(".py"))
            .sort();
          errors.push(
            `Generated test did not execute independently (${paths.join(", ")}): ${nonExecutionReason}`
          );
        }
      } catch (error) {
        const paths = changes
          .map((change) => change.filePath)
          .filter((path) => path.startsWith("tests/") && path.endsWith(".py"))
          .sort();
        errors.push(
          `Generated test failed independently (${paths.join(", ")}): ${conciseGeneratedTestFailure(error, repoPath)}`
        );
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
    errors.push(...evaluateContainmentChecks(evalCase, changes));

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
      const candidatePaths = [...new Set(paths.flatMap((path) => {
        const matchingChangedFiles = [...changedFiles].filter((filePath) => filePath === path || filePath.includes(path));
        return matchingChangedFiles.length > 0 ? matchingChangedFiles : [path];
      }))];
      const matched = await Promise.all(candidatePaths.map(async (path) => {
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

function evaluateContainmentChecks(evalCase: EvalCase, changes: GeneratedChange[]): string[] {
  const errors: string[] = [];
  if (evalCase.allowedChangedFilePatterns) {
    errors.push(...validateAllowedChangedPaths(
      changes.map((change) => change.filePath),
      evalCase.allowedChangedFilePatterns
    ));
  }
  for (const change of changes) {
    const unchangedSymbols = [
      ...(evalCase.unchangedPythonSymbols?.[change.filePath] ?? []),
      ...(evalCase.unchangedSymbols?.[change.filePath] ?? [])
    ];
    errors.push(...validateUnchangedSymbols(change, unchangedSymbols));
    errors.push(...validateUnchangedSymbolsWithAllowedLines(
      change,
      evalCase.allowedSymbolAdditions?.[change.filePath] ?? {}
    ));
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

function isOpenExpectation(expectation: FrontendAssertion["expect"][number]): expectation is { selector: string | string[]; open: boolean } {
  return "open" in expectation;
}

function isDialogExpectation(expectation: FrontendAssertion["expect"][number]): expectation is { selector: string | string[]; dialog: true } {
  return "dialog" in expectation;
}

function selectorLabel(selector: string | string[]): string {
  return Array.isArray(selector) ? selector.join(" OR ") : selector;
}

function selectorAlternatives(selector: string | string[]): string[] {
  return Array.isArray(selector) ? selector : [selector];
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

function shouldAssertKeyboardActivation(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();
  const isNativeKeyboardControl = ["button", "input", "select", "textarea", "summary"].includes(tagName) ||
    (tagName === "a" && element.hasAttribute("href"));

  if (isNativeKeyboardControl) {
    return false;
  }

  const role = element.getAttribute("role")?.toLowerCase();
  return role === "button" || role === "link" || element.hasAttribute("tabindex");
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
  const recordRuntimeError = (message: string): void => {
    if (message.length > 0 && !runtimeErrors.includes(message)) {
      runtimeErrors.push(message);
    }
  };
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
    const reason = event.reason as unknown;
    recordRuntimeError(reason instanceof Error ? reason.message : String(reason));
  });

  dom.window.console = {
    ...dom.window.console,
    error: (...args: unknown[]) => recordRuntimeError(args.map(String).join(" "))
  };

  const dialogPrototype = dom.window.HTMLDialogElement?.prototype;
  if (dialogPrototype && typeof dialogPrototype.showModal !== "function") {
    dialogPrototype.showModal = function showModal(): void {
      this.setAttribute("open", "");
    };
  }
  if (dialogPrototype && typeof dialogPrototype.close !== "function") {
    dialogPrototype.close = function close(): void {
      this.removeAttribute("open");
      this.dispatchEvent(new dom.window.Event("close"));
    };
  }

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

  const addRequirement = (requirement: FrontendRepairRequirement): void => {
    errors.push(formatFrontendRepairRequirement(requirement));
  };

  const assertExpectations = (
    assertion: FrontendAssertion,
    action: "assert" | "keyboard_activate",
    previousOpenStates: Map<
      FrontendAssertion["expect"][number],
      ReturnType<typeof captureFrontendElementOpenState>
    >
  ): void => {
    for (const expectation of assertion.expect) {
      const elements = querySelectorAll(dom.window.document, expectation.selector);
      const selectors = selectorAlternatives(expectation.selector);
      if (isCountExpectation(expectation)) {
        if (elements.length < expectation.minCount) {
          addRequirement({
            assertion: assertion.name,
            action,
            selectorAlternatives: selectors,
            expectation: { kind: "min_count", value: expectation.minCount },
            actual: { matchCount: elements.length }
          });
        }
        continue;
      }

      const element = elements[0];
      if (!element) {
        addRequirement({
          assertion: assertion.name,
          action,
          selectorAlternatives: selectors,
          expectation: { kind: "exists" },
          actual: { matchCount: 0 }
        });
        continue;
      }

      if (isTextExpectation(expectation)) {
        const text = element.textContent ?? "";
        if (!text.includes(expectation.textIncludes)) {
          addRequirement({
            assertion: assertion.name,
            action,
            selectorAlternatives: selectors,
            expectation: { kind: "text_includes", value: expectation.textIncludes },
            actual: { matchCount: elements.length, text }
          });
        }
      } else if (isAttributeExpectation(expectation)) {
        const actual = element.getAttribute(expectation.attribute);
        if (actual !== expectation.equals) {
          addRequirement({
            assertion: assertion.name,
            action,
            selectorAlternatives: selectors,
            expectation: {
              kind: "attribute_equals",
              attribute: expectation.attribute,
              value: expectation.equals
            },
            actual: { matchCount: elements.length, value: actual }
          });
        }
      } else if (isClassExpectation(expectation) && !hasExpectedClass(element, expectation.hasClass)) {
        addRequirement({
          assertion: assertion.name,
          action,
          selectorAlternatives: selectors,
          expectation: {
            kind: "class_any",
            values: selectorAlternatives(expectation.hasClass)
          },
          actual: { matchCount: elements.length, classes: [...element.classList] }
        });
      } else if (isOpenExpectation(expectation) &&
          frontendElementIsOpen(element, previousOpenStates.get(expectation)) !== expectation.open) {
        addRequirement({
          assertion: assertion.name,
          action,
          selectorAlternatives: selectors,
          expectation: { kind: "open_state", value: expectation.open ? "open" : "closed" },
          actual: {
            matchCount: elements.length,
            tagName: element.tagName.toLowerCase(),
            before: previousOpenStates.get(expectation) ?? null,
            after: captureFrontendElementOpenState(element)
          }
        });
      } else if (isDialogExpectation(expectation) && !frontendElementHasDialogSemantics(element)) {
        addRequirement({
          assertion: assertion.name,
          action,
          selectorAlternatives: selectors,
          expectation: { kind: "dialog_semantics" },
          actual: {
            matchCount: elements.length,
            tagName: element.tagName.toLowerCase(),
            role: element.getAttribute("role")
          }
        });
      }
    }
  };

  const captureOpenStates = (
    assertion: FrontendAssertion
  ): Map<FrontendAssertion["expect"][number], ReturnType<typeof captureFrontendElementOpenState>> => {
    const states = new Map<
      FrontendAssertion["expect"][number],
      ReturnType<typeof captureFrontendElementOpenState>
    >();
    for (const expectation of assertion.expect) {
      if (!isOpenExpectation(expectation)) {
        continue;
      }
      const element = querySelector(dom.window.document, expectation.selector);
      if (element) {
        states.set(expectation, captureFrontendElementOpenState(element));
      }
    }
    return states;
  };

  for (const assertion of evalCase.frontendAssertions) {
    try {
      const clickable = querySelector(dom.window.document, assertion.click);
      if (!clickable) {
        addRequirement({
          assertion: assertion.name,
          action: "click",
          selectorAlternatives: selectorAlternatives(assertion.click),
          expectation: { kind: "exists" },
          actual: { matchCount: 0 }
        });
        continue;
      }

      if (shouldAssertKeyboardActivation(clickable)) {
        const previousOpenStates = captureOpenStates(assertion);
        clickable.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
        assertExpectations(assertion, "keyboard_activate", previousOpenStates);
      }

      const previousOpenStates = captureOpenStates(assertion);
      clickable.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
      assertExpectations(assertion, "assert", previousOpenStates);
    } catch (error) {
      addRequirement({
        assertion: assertion.name,
        action: "runtime",
        selectorAlternatives: [],
        expectation: { kind: "no_runtime_errors" },
        actual: { error: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  if (runtimeErrors.length > 0) {
    addRequirement({
      assertion: "Frontend runtime",
      action: "runtime",
      selectorAlternatives: [],
      expectation: { kind: "no_runtime_errors" },
      actual: { errors: runtimeErrors }
    });
  }

  dom.window.close();
  return errors;
}

async function runCase(evalCase: EvalCase, options: ReturnType<typeof parseArgs>): Promise<EvalResult> {
  const runId = options.runId ?? evalCase.id;
  const artifactPath = join(options.outputDir, runId);
  const safetyAssessment = assessFeedbackContent(evalCase.feedback.rawContent);
  if (evalCase.expectedSafetyOutcome === "rejected") {
    await mkdir(artifactPath, { recursive: true });
    await writeFile(join(artifactPath, "safety.json"), `${JSON.stringify(safetyAssessment, null, 2)}\n`, "utf8");
    await writeJsonAtomically(join(artifactPath, "usage.json"), emptyEvalUsageSummary());
    const passed = !safetyAssessment.accepted;
    return {
      id: runId,
      caseId: evalCase.id,
      trial: options.trial,
      passed,
      tempPath: "",
      generated: false,
      references: [],
      loadedFiles: [],
      changedFiles: [],
      errors: passed ? [] : ["Unsafe benchmark feedback was unexpectedly accepted"],
      artifactPath,
      usage: emptyEvalUsageSummary(),
      scopeViolations: [],
      safetyAssessment,
      repairAttempts: { modelAttempts: 0, deterministicAttempts: 0, totalAttempts: 0, stages: [] }
    };
  }
  if (evalCase.expectedSafetyOutcome === "accepted" && !safetyAssessment.accepted) {
    throw new Error(`Safe benchmark feedback was unexpectedly rejected: ${safetyAssessment.reasons.join("; ")}`);
  }

  if (!evalCase.fixturePath && (!evalCase.repoDirName || !evalCase.baseRef)) {
    throw new Error(`Eval case ${evalCase.id} requires fixturePath or both repoDirName and baseRef`);
  }

  const sourceRepo = evalCase.fixturePath
    ? resolve(evalCase.fixturePath)
    : resolve(options.repoRoot, evalCase.repoDirName ?? "");
  const repoPath = evalCase.fixturePath
    ? await copyFixtureSource(sourceRepo)
    : await copyRepoAtRef(sourceRepo, evalCase.baseRef ?? "");
  await mkdir(artifactPath, { recursive: true });
  await writeFile(join(artifactPath, "temp-path.txt"), `${repoPath}\n`, "utf8");
  const telemetry = await createEvalTelemetry(options, artifactPath);
  const repoIndexer = new RepoIndexer();
  const repoContext: RepoContext = {
    fullName: evalCase.repoFullName,
    defaultBranch: "main",
    localPath: repoPath,
    fileTree: await buildFileTree(repoPath),
    installationId: 0
  };

  let classifiedFeedback: ClassifiedFeedback = {
    id: runId,
    repoFullName: evalCase.repoFullName,
    receivedAt: new Date(),
    metadata: {},
    ...evalCase.feedback
  };

  let routes = resolveEvalLlmRoutes({
    provider: options.provider,
    model: options.model,
    preset: options.preset,
    feedback: classifiedFeedback
  });
  let classificationPasses: OpenAIClassificationPass[] | undefined;

  if (options.classify) {
    const classificationFileTree = visibleFileTreePaths(repoIndexer, repoContext, evalCase);
    if (options.provider === "openai" && options.preset !== "direct") {
      const routedClassification = await classifyFeedbackWithOpenAIRouting({
        feedbackItem: classifiedFeedback,
        fileTree: classificationFileTree,
        modelPreset: options.preset,
        createClient: (route) => createEvalLlmClient(
          "openai",
          route,
          telemetry,
          "classification"
        )
      });
      classifiedFeedback = routedClassification.classifiedFeedback;
      classificationPasses = routedClassification.passes;
    } else {
      const classifier = new FeedbackClassifier(createEvalLlmClient(
        options.provider,
        routes.classification,
        telemetry,
        "classification"
      ));
      classifiedFeedback = await classifier.classify(classifiedFeedback, classificationFileTree);
    }
    routes = resolveEvalLlmRoutes({
      provider: options.provider,
      model: options.model,
      preset: options.preset,
      feedback: classifiedFeedback
    });
  }
  const routingErrors = evalCase.expectedOpenAIRoute
    ? options.provider !== "openai"
      ? ["Expected OpenAI route cannot be checked with a non-OpenAI provider"]
      : !options.classify
        ? ["Expected OpenAI route requires live classification"]
        : validateExpectedOpenAIRoute(routes, evalCase.expectedOpenAIRoute)
    : [];
  await writeFile(join(artifactPath, "routing.json"), `${JSON.stringify({
    classificationPasses: classificationPasses ?? [],
    finalClassification: classifiedFeedback,
    routes
  }, null, 2)}\n`, "utf8");

  let relevantFiles = await repoIndexer.findRelevantFiles(repoContext, classifiedFeedback);
  relevantFiles = partitionVisibleContext(
    relevantFiles,
    evalCase.oracleTestPaths ?? [],
    evalCase.oracleTestPathPrefixes ?? []
  ).visible;
  const referenceFiles = await repoIndexer.findRepositoryReferenceFiles(repoContext, classifiedFeedback, {
    issueNumber: evalCase.issueNumber
  });
  const partitionedReferences = partitionVisibleContext(
    referenceFiles,
    evalCase.oracleTestPaths ?? [],
    evalCase.oracleTestPathPrefixes ?? []
  );
  relevantFiles = mergeFiles(relevantFiles, partitionedReferences.visible);

  let changes: GeneratedChange[] = [];
  let generated = false;
  let rawSolutionPassed: boolean | undefined;
  let rawFailureSurface: EvalResult["rawFailureSurface"];
  const errors: string[] = [...routingErrors];
  let implementationPlan: ImplementationPlan | undefined;
  const validationHistory: Array<{ stage: string; errors: string[] }> = [];
  const validationCandidates: Array<{
    stage: string;
    selected: boolean;
    changes: GeneratedChange[];
  }> = [];
  const verificationHistory: Array<{ stage: string; errors: string[] }> = [];
  const persistArtifacts = async (): Promise<void> => writeCaseArtifacts(artifactPath, {
    plan: implementationPlan ?? null,
    selectedContext: relevantFiles.map(({ path, reason }) => ({ path, reason })),
    changes,
    validationHistory,
    validationCandidates,
    verificationHistory
  });
  await persistArtifacts();

  if (options.generate) {
    generated = true;
    const fileTree = visibleFileTreePaths(repoIndexer, repoContext, evalCase);
    const planner = new ImplementationPlanner(createEvalLlmClient(options.provider, routes.planning, telemetry, "planning"));
    const plannedImplementation = await planner.plan(classifiedFeedback, relevantFiles, fileTree);
    implementationPlan = sanitizePlanForImmutablePaths(plannedImplementation, {
      oraclePaths: evalCase.oracleTestPaths ?? [],
      oraclePathPrefixes: evalCase.oracleTestPathPrefixes ?? [],
      generatedTestPathPrefixes: evalCase.generatedTestPathPrefixes ?? []
    });
    const plannedFiles = await repoIndexer.readFiles(repoContext, implementationPlan.requiredFiles);
    relevantFiles = mergeFiles(relevantFiles, plannedFiles);
    const partitionedPlannedFiles = partitionVisibleContext(
      relevantFiles,
      evalCase.oracleTestPaths ?? [],
      evalCase.oracleTestPathPrefixes ?? []
    );
    relevantFiles = partitionedPlannedFiles.visible;
    await persistArtifacts();
    const generator = new CodeGenerator(createEvalLlmClient(options.provider, routes.generation, telemetry, "generation-and-repair"));
    try {
      changes = await generateValidatedChanges(
        generator,
        classifiedFeedback,
        relevantFiles,
        fileTree,
        implementationPlan,
        repoContext,
        (stage, validationErrors, candidateChanges, selected) => {
          validationHistory.push({ stage, errors: validationErrors });
          validationCandidates.push({ stage, selected, changes: candidateChanges });
          if (selected) {
            changes = candidateChanges;
          }
        },
        (candidateChanges) => evaluateContainmentChecks(evalCase, candidateChanges)
      );
    } catch (error) {
      await persistArtifacts();
      throw error;
    }
    changes = relocateGeneratedTestsFromImmutablePaths(changes, {
      oraclePaths: evalCase.oracleTestPaths ?? [],
      oraclePathPrefixes: evalCase.oracleTestPathPrefixes ?? [],
      generatedTestPathPrefixes: evalCase.generatedTestPathPrefixes ?? []
    });
    assertGeneratedPathsAllowed(changes.map((change) => change.filePath), {
      oraclePaths: evalCase.oracleTestPaths ?? [],
      oraclePathPrefixes: evalCase.oracleTestPathPrefixes ?? [],
      generatedTestPathPrefixes: evalCase.generatedTestPathPrefixes ?? []
    });
    await persistArtifacts();
    await writeGeneratedChanges(repoPath, changes);
    repoContext.fileTree = await buildFileTree(repoPath);
    let verificationErrors = await runVerification(evalCase, repoPath, changes);
    verificationHistory.push({ stage: "initial", errors: verificationErrors });
    const initialValidationErrors = validationHistory.find(({ stage }) => stage === "initial")?.errors ?? [];
    let rawCheckErrors: string[] = [];
    let rawHiddenOracleErrors: string[] = [];
    if (initialValidationErrors.length === 0 && verificationErrors.length === 0) {
      rawCheckErrors = await evaluateChecks(
        evalCase,
        repoPath,
        referenceFiles.map((file) => file.path),
        relevantFiles.map((file) => file.path),
        changes,
        generated
      );
      verificationHistory.push({ stage: "raw-deterministic-checks", errors: rawCheckErrors });
      if (rawCheckErrors.length === 0) {
        rawHiddenOracleErrors = await runVerification(evalCase, repoPath, changes, {
          scope: "oracle",
          runChangedTests: false
        });
        verificationHistory.push({ stage: "raw-hidden-oracle", errors: rawHiddenOracleErrors });
      }
    }
    const rawOutcome = assessRawSolutionOutcome({
      validation: initialValidationErrors,
      verification: verificationErrors,
      deterministicChecks: rawCheckErrors,
      hiddenOracle: rawHiddenOracleErrors
    });
    rawSolutionPassed = rawOutcome.passed;
    rawFailureSurface = rawOutcome.failureSurface;
    await persistArtifacts();
    if (verificationErrors.length > 0) {
      const completedChanges = applyVerificationFallbacks(changes, verificationErrors);
      if (completedChanges) {
        let completedValidation = await validate(completedChanges, repoContext);
        const completedPlanErrors = validatePlanCompletion(completedChanges, implementationPlan, `${classifiedFeedback.summary}\n${classifiedFeedback.rawContent}`);
        if (completedPlanErrors.length > 0) {
          completedValidation = {
            valid: false,
            errors: [...completedValidation.errors, ...completedPlanErrors]
          };
        }
        validationHistory.push({ stage: "verification-deterministic-repair", errors: completedValidation.errors });
        if (completedValidation.valid) {
          await writeGeneratedChanges(repoPath, completedChanges);
          repoContext.fileTree = await buildFileTree(repoPath);
          const completedVerificationErrors = await runVerification(evalCase, repoPath, completedChanges);
          const progress = assessRepairProgress(changes, completedChanges, verificationErrors, completedVerificationErrors, {
            plannedFiles: implementationPlan.requiredFiles.map((file) => file.path)
          });
          verificationHistory.push({
            stage: `verification-deterministic-repair-${progress.trend}`,
            errors: completedVerificationErrors
          });
          if (progress.accepted) {
            changes = completedChanges;
            verificationErrors = completedVerificationErrors;
          } else {
            await writeGeneratedChanges(repoPath, changes);
            repoContext.fileTree = await buildFileTree(repoPath);
          }
          await persistArtifacts();
        }
      }
    }
    if (verificationErrors.length > 0) {
      const preRepairChanges = changes;
      let repairedChanges = await repairVerificationFailure(
        generator,
        classifiedFeedback,
        relevantFiles,
        fileTree,
        implementationPlan,
        repoContext,
        changes,
        verificationErrors,
        (stage, validationErrors) => validationHistory.push({ stage, errors: validationErrors })
      );
      if (repairedChanges.length > 0) {
        repairedChanges = relocateGeneratedTestsFromImmutablePaths(repairedChanges, {
          oraclePaths: evalCase.oracleTestPaths ?? [],
          oraclePathPrefixes: evalCase.oracleTestPathPrefixes ?? [],
          generatedTestPathPrefixes: evalCase.generatedTestPathPrefixes ?? []
        });
        assertGeneratedPathsAllowed(repairedChanges.map((change) => change.filePath), {
          oraclePaths: evalCase.oracleTestPaths ?? [],
          oraclePathPrefixes: evalCase.oracleTestPathPrefixes ?? [],
          generatedTestPathPrefixes: evalCase.generatedTestPathPrefixes ?? []
        });
        await writeGeneratedChanges(repoPath, repairedChanges);
        repoContext.fileTree = await buildFileTree(repoPath);
        const repairedVerificationErrors = await runVerification(evalCase, repoPath, repairedChanges);
        const progress = assessRepairProgress(
          preRepairChanges,
          repairedChanges,
          verificationErrors,
          repairedVerificationErrors,
          { plannedFiles: implementationPlan.requiredFiles.map((file) => file.path) }
        );
        verificationHistory.push({
          stage: `verification-repair-${progress.trend}`,
          errors: repairedVerificationErrors
        });
        if (progress.accepted) {
          changes = repairedChanges;
          verificationErrors = repairedVerificationErrors;
        } else {
          await writeGeneratedChanges(repoPath, preRepairChanges);
          repoContext.fileTree = await buildFileTree(repoPath);
        }
        await persistArtifacts();
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

  if (options.generate && implementationPlan && checkErrors.length > 0) {
    const preRepairChanges = changes;
    const completedChanges = applyVerificationFallbacks(changes, checkErrors);
    if (completedChanges) {
      assertGeneratedPathsAllowed(completedChanges.map((change) => change.filePath), {
        oraclePaths: evalCase.oracleTestPaths ?? [],
        oraclePathPrefixes: evalCase.oracleTestPathPrefixes ?? [],
        generatedTestPathPrefixes: evalCase.generatedTestPathPrefixes ?? []
      });
      let completedValidation = await validate(completedChanges, repoContext);
      const completedPlanErrors = validatePlanCompletion(
        completedChanges,
        implementationPlan,
        `${classifiedFeedback.summary}\n${classifiedFeedback.rawContent}`
      );
      if (completedPlanErrors.length > 0) {
        completedValidation = {
          valid: false,
          errors: [...completedValidation.errors, ...completedPlanErrors]
        };
      }
      validationHistory.push({ stage: "check-deterministic-repair", errors: completedValidation.errors });
      validationCandidates.push({
        stage: "check-deterministic-repair",
        selected: false,
        changes: completedChanges
      });

      if (completedValidation.valid) {
        await writeGeneratedChanges(repoPath, completedChanges);
        repoContext.fileTree = await buildFileTree(repoPath);
        const completedVerificationErrors = await runVerification(evalCase, repoPath, completedChanges);
        const completedCheckErrors = completedVerificationErrors.length > 0
          ? checkErrors
          : await evaluateChecks(
              evalCase,
              repoPath,
              referenceFiles.map((file) => file.path),
              relevantFiles.map((file) => file.path),
              completedChanges,
              generated
            );
        const progress = assessRepairProgress(
          changes,
          completedChanges,
          checkErrors,
          [...completedVerificationErrors, ...completedCheckErrors],
          { plannedFiles: implementationPlan.requiredFiles.map((file) => file.path) }
        );
        verificationHistory.push({
          stage: `check-deterministic-repair-${progress.trend}`,
          errors: [...completedVerificationErrors, ...completedCheckErrors]
        });
        if (progress.accepted) {
          validationCandidates[validationCandidates.length - 1].selected = true;
          changes = completedChanges;
          errors.push(...completedVerificationErrors);
          checkErrors = completedCheckErrors;
        } else {
          await writeGeneratedChanges(repoPath, preRepairChanges);
          repoContext.fileTree = await buildFileTree(repoPath);
        }
      }
      await persistArtifacts();
    }
  }

  if (options.generate && implementationPlan && checkErrors.length > 0) {
    const preRepairChanges = changes;
    const fileTree = visibleFileTreePaths(repoIndexer, repoContext, evalCase);
    const generator = new CodeGenerator(createEvalLlmClient(
      options.provider,
      routes.generation,
      telemetry,
      "check-repair"
    ));
    let repairedChanges = await repairVerificationFailure(
      generator,
      classifiedFeedback,
      relevantFiles,
      fileTree,
      implementationPlan,
      repoContext,
      changes,
      checkErrors,
      (stage, validationErrors) => validationHistory.push({ stage, errors: validationErrors })
    );
    if (repairedChanges.length > 0) {
      repairedChanges = relocateGeneratedTestsFromImmutablePaths(repairedChanges, {
        oraclePaths: evalCase.oracleTestPaths ?? [],
        oraclePathPrefixes: evalCase.oracleTestPathPrefixes ?? [],
        generatedTestPathPrefixes: evalCase.generatedTestPathPrefixes ?? []
      });
      assertGeneratedPathsAllowed(repairedChanges.map((change) => change.filePath), {
        oraclePaths: evalCase.oracleTestPaths ?? [],
        oraclePathPrefixes: evalCase.oracleTestPathPrefixes ?? [],
        generatedTestPathPrefixes: evalCase.generatedTestPathPrefixes ?? []
      });
      await writeGeneratedChanges(repoPath, repairedChanges);
      repoContext.fileTree = await buildFileTree(repoPath);
      const repairedVerificationErrors = await runVerification(evalCase, repoPath, repairedChanges);
      const repairedCheckErrors = repairedVerificationErrors.length > 0
        ? checkErrors
        : await evaluateChecks(
            evalCase,
            repoPath,
            referenceFiles.map((file) => file.path),
            relevantFiles.map((file) => file.path),
            repairedChanges,
            generated
          );
      const progress = assessRepairProgress(
        preRepairChanges,
        repairedChanges,
        checkErrors,
        [...repairedVerificationErrors, ...repairedCheckErrors],
        { plannedFiles: implementationPlan.requiredFiles.map((file) => file.path) }
      );
      verificationHistory.push({
        stage: `check-repair-${progress.trend}`,
        errors: [...repairedVerificationErrors, ...repairedCheckErrors]
      });
      await persistArtifacts();
      if (progress.accepted) {
        changes = repairedChanges;
        errors.push(...repairedVerificationErrors);
        checkErrors = repairedCheckErrors;
      } else {
        await writeGeneratedChanges(repoPath, preRepairChanges);
        repoContext.fileTree = await buildFileTree(repoPath);
      }
    } else {
      verificationHistory.push({
        stage: "check-repair-no-candidate",
        errors: checkErrors
      });
      await persistArtifacts();
    }
  }

  errors.push(...checkErrors);
  const hiddenOracleErrors = await runVerification(evalCase, repoPath, changes, {
    scope: "oracle",
    runChangedTests: false
  });
  verificationHistory.push({ stage: "hidden-oracle", errors: hiddenOracleErrors });
  errors.push(...hiddenOracleErrors);
  await persistArtifacts();

  const usage = telemetry?.snapshot();
  const routePassed = routingErrors.length === 0;
  const finalSolutionPassed = errors.length === routingErrors.length;
  return {
    id: runId,
    caseId: evalCase.id,
    trial: options.trial,
    passed: routePassed && finalSolutionPassed,
    tempPath: repoPath,
    generated,
    references: referenceFiles.map((file) => file.path),
    loadedFiles: relevantFiles.map((file) => file.path),
    changedFiles: changes.map((change) => change.filePath),
    errors,
    artifactPath,
    usage,
    scopeViolations: errors.filter((error) => error.startsWith("Unrelated protected symbol changed")),
    routes,
    classificationPasses,
    safetyAssessment,
    routePassed,
    rawSolutionPassed,
    finalSolutionPassed,
    repairAssistedPassed: rawSolutionPassed === false && finalSolutionPassed,
    rawFailureSurface,
    repairAttempts: summarizeRepairAttempts(
      usage?.calls ?? [],
      validationHistory.map(({ stage }) => stage),
      verificationHistory.map(({ stage }) => stage)
    )
  };
}

async function generateValidatedChanges(
  generator: CodeGenerator,
  feedback: ClassifiedFeedback,
  relevantFiles: Array<{ path: string; content: string; reason: string }>,
  fileTree: string[],
  implementationPlan: ImplementationPlan,
  repoContext: RepoContext,
  recordValidation: (
    stage: string,
    errors: string[],
    candidateChanges: GeneratedChange[],
    selected: boolean
  ) => void = () => {},
  additionalValidationErrors: (changes: GeneratedChange[]) => string[] = () => []
): Promise<GeneratedChange[]> {
  let changes = await generator.generate(feedback, relevantFiles, fileTree, implementationPlan, {
    completeSolution: true
  });
  const feedbackText = `${feedback.summary}\n${feedback.rawContent}`;
  let validation = await validate(changes, repoContext);
  const planErrors = validatePlanCompletion(changes, implementationPlan, feedbackText);
  const containmentErrors = additionalValidationErrors(changes);
  if (planErrors.length > 0 || containmentErrors.length > 0) {
    validation = {
      valid: false,
      errors: [...validation.errors, ...planErrors, ...containmentErrors]
    };
  }
  recordValidation("initial", validation.errors, changes, true);

  for (let attempt = 0; !validation.valid && attempt < validationRecoveryAttempts; attempt += 1) {
    if (validation.errors.some((error) => scopeValidationPattern.test(error))) {
      const scopedChanges = pruneChangesToPlanScope(changes, implementationPlan, feedbackText);
      if (scopedChanges.length > 0 && scopedChanges.length < changes.length) {
        changes = scopedChanges;
        validation = await validate(changes, repoContext);
        const scopedPlanErrors = validatePlanCompletion(changes, implementationPlan, feedbackText);
        const scopedContainmentErrors = additionalValidationErrors(changes);
        if (scopedPlanErrors.length > 0 || scopedContainmentErrors.length > 0) {
          validation = {
            valid: false,
            errors: [...validation.errors, ...scopedPlanErrors, ...scopedContainmentErrors]
          };
        }
        recordValidation(`scope-prune-${attempt + 1}`, validation.errors, changes, true);

        if (validation.valid) {
          break;
        }
      }
    }

    let madeProgress = false;
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
        const candidateChanges = validation.errors.some((error) => oversizedPatchPattern.test(error) || scopeValidationPattern.test(error))
          ? repairedChanges
          : mergeGeneratedChanges(changes, repairedChanges);
        let candidateValidation = await validate(candidateChanges, repoContext);
        const repairedPlanErrors = validatePlanCompletion(candidateChanges, implementationPlan, feedbackText);
        const repairedContainmentErrors = additionalValidationErrors(candidateChanges);
        if (repairedPlanErrors.length > 0 || repairedContainmentErrors.length > 0) {
          candidateValidation = {
            valid: false,
            errors: [...candidateValidation.errors, ...repairedPlanErrors, ...repairedContainmentErrors]
          };
        }
        const progress = assessRepairProgress(changes, candidateChanges, validation.errors, candidateValidation.errors, {
          plannedFiles: implementationPlan.requiredFiles.map((file) => file.path)
        });
        recordValidation(
          `model-repair-${progress.trend}-${attempt + 1}`,
          candidateValidation.errors,
          candidateChanges,
          progress.accepted
        );
        if (progress.accepted) {
          changes = candidateChanges;
          madeProgress = true;
          validation = candidateValidation;
        }
      }
    } catch (error) {
      if (!isRecoverableLlmFailure(error)) {
        throw error;
      }
    }

    if (!validation.valid) {
      const completedChanges = await applyValidationFallbacks(changes, repoContext, validation.errors);
      if (completedChanges !== changes) {
        let completedValidation = await validate(completedChanges, repoContext);
        const completedPlanErrors = validatePlanCompletion(completedChanges, implementationPlan, feedbackText);
        const completedContainmentErrors = additionalValidationErrors(completedChanges);
        if (completedPlanErrors.length > 0 || completedContainmentErrors.length > 0) {
          completedValidation = {
            valid: false,
            errors: [...completedValidation.errors, ...completedPlanErrors, ...completedContainmentErrors]
          };
        }
        const progress = assessRepairProgress(changes, completedChanges, validation.errors, completedValidation.errors, {
          plannedFiles: implementationPlan.requiredFiles.map((file) => file.path)
        });
        recordValidation(
          `deterministic-repair-${progress.trend}-${attempt + 1}`,
          completedValidation.errors,
          completedChanges,
          progress.accepted
        );
        if (progress.accepted) {
          changes = completedChanges;
          madeProgress = true;
          validation = completedValidation;
        }
      }
    }

    if (!madeProgress) {
      break;
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
  verificationErrors: string[],
  recordValidation: (stage: string, errors: string[]) => void = () => {}
): Promise<GeneratedChange[]> {
  let repairedChanges: GeneratedChange[];
  try {
    repairedChanges = await generator.repairValidationFailure(
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
  } catch (error) {
    if (isRecoverableLlmFailure(error)) {
      return [];
    }
    throw error;
  }

  if (repairedChanges.length === 0) {
    return [];
  }

  repairedChanges = mergeGeneratedChanges(currentChanges, repairedChanges);
  const unplannedAddedFiles = findUnplannedAddedFiles(
    currentChanges,
    repairedChanges,
    implementationPlan.requiredFiles.map((file) => file.path)
  );
  if (unplannedAddedFiles.length > 0) {
    recordValidation("verification-repair-increased", [
      ...verificationErrors,
      `Repair added files outside the implementation plan: ${unplannedAddedFiles.join(", ")}`
    ]);
    return [];
  }

  const feedbackText = `${feedback.summary}\n${feedback.rawContent}`;
  let validation = await validate(repairedChanges, repoContext);
  const planErrors = validatePlanCompletion(repairedChanges, implementationPlan, feedbackText);
  if (planErrors.length > 0) {
    validation = {
      valid: false,
      errors: [...validation.errors, ...planErrors]
    };
  }
  recordValidation("verification-model-repair", validation.errors);

  if (!validation.valid) {
    const completedChanges = await applyValidationFallbacks(repairedChanges, repoContext, validation.errors);
    if (completedChanges !== repairedChanges) {
      validation = await validate(completedChanges, repoContext);
      const completedPlanErrors = validatePlanCompletion(completedChanges, implementationPlan, feedbackText);
      if (completedPlanErrors.length > 0) {
        validation = {
          valid: false,
          errors: [...validation.errors, ...completedPlanErrors]
        };
      }
      recordValidation("verification-deterministic-repair", validation.errors);

      if (validation.valid) {
        return completedChanges;
      }
    }
  }

  return validation.valid ? repairedChanges : [];
}

function childArguments(
  options: ReturnType<typeof parseArgs>,
  evalCase: EvalCase,
  trialRun: EvalTrialRun,
  resultPath: string
): string[] {
  return [
    resolve("scripts/eval-local-fixes.ts"),
    "--internal-case", evalCase.id,
    "--trial", String(trialRun.trial),
    "--run-id", trialRun.runId,
    "--result-path", resultPath,
    "--cases", options.casesPath,
    "--repo-root", options.repoRoot,
    "--provider", options.provider,
    "--model", options.model,
    "--preset", options.preset,
    "--case-timeout-ms", String(options.caseTimeoutMs),
    "--output-dir", options.outputDir,
    ...(options.maxCostUsd === undefined ? [] : ["--max-cost-usd", String(options.maxCostUsd)]),
    ...(options.pricingPath ? ["--pricing", options.pricingPath] : []),
    ...(options.generate ? ["--generate"] : []),
    ...(options.classify ? ["--classify"] : []),
    ...(options.frozenEvaluation ? ["--frozen-evaluation"] : []),
    ...(options.keep ? ["--keep"] : [])
  ];
}

async function runCaseInChild(
  evalCase: EvalCase,
  trialRun: EvalTrialRun,
  options: ReturnType<typeof parseArgs>,
  signal: AbortSignal,
  recordInterruptedUsage: (usage: EvalUsageSummary) => void = () => {}
): Promise<EvalResult> {
  const resultPath = join(options.outputDir, trialRun.runId, "result.json");

  return new Promise<EvalResult>((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [...process.execArgv, ...childArguments(options, evalCase, trialRun, resultPath)], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let forceKillTimeout: NodeJS.Timeout | undefined;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.pipe(process.stdout);

    const abort = (): void => {
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => child.kill("SIGKILL"), 1_000);
    };
    signal.addEventListener("abort", abort, { once: true });

    child.once("error", (error) => {
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      signal.removeEventListener("abort", abort);
      rejectResult(error);
    });
    child.once("close", async (code) => {
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      signal.removeEventListener("abort", abort);
      const artifactPath = join(options.outputDir, trialRun.runId);
      const usage = await readFile(join(artifactPath, "usage.json"), "utf8")
        .then((content) => JSON.parse(content) as EvalUsageSummary)
        .catch(() => undefined);
      if (signal.aborted) {
        if (usage) {
          recordInterruptedUsage(usage);
        }
        const validationStages = await readFile(join(artifactPath, "validation-history.json"), "utf8")
          .then((content) => (JSON.parse(content) as Array<{ stage: string }>).map(({ stage }) => stage))
          .catch(() => [] as string[]);
        const verificationStages = await readFile(join(artifactPath, "verification-history.json"), "utf8")
          .then((content) => (JSON.parse(content) as Array<{ stage: string }>).map(({ stage }) => stage))
          .catch(() => [] as string[]);
        const tempPath = await readFile(join(artifactPath, "temp-path.txt"), "utf8")
          .then((content) => content.trim())
          .catch(() => "");
        const message = signal.reason instanceof Error
          ? signal.reason.message
          : `Eval case aborted: ${evalCase.id}`;
        rejectResult(new EvalCaseExecutionError(message, {
          caseId: evalCase.id,
          trial: trialRun.trial,
          tempPath,
          generated: options.generate,
          references: [],
          loadedFiles: [],
          changedFiles: [],
          artifactPath,
          usage,
          scopeViolations: [],
          repairAttempts: summarizeRepairAttempts(usage?.calls ?? [], validationStages, verificationStages)
        }));
        return;
      }
      try {
        const result = JSON.parse(await readFile(resultPath, "utf8")) as EvalResult;
        resolveResult(result);
      } catch (error) {
        if (usage) {
          recordInterruptedUsage(usage);
        }
        const details = stderr.trim();
        rejectResult(new Error(
          `Eval child exited with code ${String(code)} without a result${details ? `: ${details}` : ""}`,
          { cause: error }
        ));
      }
    });
  });
}

function failedResult(evalCase: EvalCase, options: ReturnType<typeof parseArgs>, error: unknown): EvalResult {
  const runId = options.runId ?? evalCase.id;
  return {
    id: runId,
    caseId: evalCase.id,
    trial: options.trial,
    passed: false,
    tempPath: "",
    generated: options.generate,
    references: [],
    loadedFiles: [],
    changedFiles: [],
    errors: [error instanceof Error ? error.message : String(error)],
    artifactPath: join(options.outputDir, runId),
    rawSolutionPassed: false,
    finalSolutionPassed: false,
    repairAssistedPassed: false,
    scopeViolations: [],
    repairAttempts: { modelAttempts: 0, deterministicAttempts: 0, totalAttempts: 0, stages: [] }
  };
}

async function runInternalCase(
  evalCase: EvalCase,
  options: ReturnType<typeof parseArgs>
): Promise<void> {
  if (!options.resultPath) {
    throw new Error("--result-path is required with --internal-case");
  }

  let result: EvalResult;
  try {
    result = await runCase(evalCase, options);
  } catch (error) {
    result = failedResult(evalCase, options, error);
    result.usage = await readFile(join(result.artifactPath, "usage.json"), "utf8")
      .then((content) => JSON.parse(content) as EvalUsageSummary)
      .catch(() => undefined);
    const validationStages = await readFile(join(result.artifactPath, "validation-history.json"), "utf8")
      .then((content) => (JSON.parse(content) as Array<{ stage: string }>).map(({ stage }) => stage))
      .catch(() => [] as string[]);
    const verificationStages = await readFile(join(result.artifactPath, "verification-history.json"), "utf8")
      .then((content) => (JSON.parse(content) as Array<{ stage: string }>).map(({ stage }) => stage))
      .catch(() => [] as string[]);
    result.repairAttempts = summarizeRepairAttempts(result.usage?.calls ?? [], validationStages, verificationStages);
  }
  await mkdir(dirname(options.resultPath), { recursive: true });
  await writeFile(options.resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

async function ensureNewOutputDir(outputDir: string): Promise<void> {
  try {
    await access(outputDir);
    throw new Error(`Output directory already exists: ${outputDir}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(outputDir, { recursive: true });
}

async function gitRevision(): Promise<string> {
  const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: process.cwd() });
  return stdout.trim();
}

async function assertTrackedWorktreeClean(): Promise<void> {
  try {
    await execFile("git", ["diff", "--quiet"], { cwd: process.cwd() });
    await execFile("git", ["diff", "--cached", "--quiet"], { cwd: process.cwd() });
  } catch {
    throw new Error("Frozen evaluation requires a clean tracked worktree and index");
  }
}

async function assertPathTracked(path: string): Promise<void> {
  const repoRelativePath = relative(process.cwd(), resolve(path));
  const { stdout } = await execFile("git", ["ls-files", "--", repoRelativePath], { cwd: process.cwd() });
  if (stdout.trim().length === 0) {
    throw new Error(`Evaluation input must be tracked before execution: ${repoRelativePath}`);
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function sha256Path(path: string): Promise<string> {
  const root = resolve(path);
  const hash = createHash("sha256");
  const visit = async (currentPath: string): Promise<void> => {
    const currentStat = await stat(currentPath);
    const pathLabel = relative(root, currentPath) || ".";
    hash.update(`${currentStat.isDirectory() ? "dir" : "file"}\0${pathLabel}\0`);
    if (currentStat.isDirectory()) {
      const entries = (await readdir(currentPath)).sort();
      for (const entry of entries) {
        await visit(join(currentPath, entry));
      }
    } else {
      hash.update(await readFile(currentPath));
    }
  };
  await visit(root);
  return hash.digest("hex");
}

async function writeRunMetadata(
  options: ReturnType<typeof parseArgs>,
  selectedCases: EvalCase[],
  startedAt: number
): Promise<void> {
  const env = getEnv();
  const fixturePaths = [...new Set(selectedCases
    .map((evalCase) => evalCase.fixturePath)
    .filter((path): path is string => Boolean(path)))];
  const trackedInputs = [options.casesPath, ...(options.pricingPath ? [options.pricingPath] : []), ...fixturePaths];
  if (options.frozenEvaluation) {
    await Promise.all(trackedInputs.map(assertPathTracked));
  }
  const fixtureHashes = Object.fromEntries(await Promise.all(fixturePaths.map(async (path) => [
    path,
    await sha256Path(path)
  ])));
  await writeFile(join(options.outputDir, "run-metadata.json"), `${JSON.stringify({
    codeCommit: await gitRevision(),
    casesPath: options.casesPath,
    casesSha256: await sha256File(options.casesPath),
    fixtureHashes,
    pricingPath: options.pricingPath ?? null,
    pricingSha256: options.pricingPath ? await sha256File(options.pricingPath) : null,
    selectedCaseIds: selectedCases.map((evalCase) => evalCase.id),
    frozenEvaluation: options.frozenEvaluation,
    trials: options.trials,
    provider: options.provider,
    preset: options.preset,
    maxCostUsd: options.maxCostUsd ?? null,
    caseTimeoutMs: options.caseTimeoutMs,
    command: process.argv,
    routeOverrides: {
      model: options.modelOverrideProvided ? options.model : env.MOSAIC_OPENAI_MODEL ?? null,
      reasoningEffort: env.MOSAIC_OPENAI_REASONING_EFFORT ?? null
    },
    openAIMinOutputTokens: env.MOSAIC_OPENAI_MIN_OUTPUT_TOKENS ?? null,
    openAIMinTimeoutMs: env.MOSAIC_OPENAI_MIN_TIMEOUT_MS ?? null,
    startedAt
  }, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if ((options.generate || options.classify) && (options.maxCostUsd === undefined || !options.pricingPath)) {
    throw new Error("Paid evaluation requires both --max-cost-usd and --pricing");
  }
  const cases = JSON.parse(await readFile(options.casesPath, "utf8")) as EvalCase[];
  if (options.internalCase) {
    const evalCase = cases.find((candidate) => candidate.id === options.internalCase);
    if (!evalCase) {
      throw new Error(`Unknown eval case: ${options.internalCase}`);
    }
    await runInternalCase(evalCase, options);
    return;
  }

  const env = getEnv();
  const unpinnedOpenAIEvaluation = options.provider === "openai" &&
    options.preset === "quality" &&
    (options.generate || options.classify);
  if (options.frozenEvaluation && unpinnedOpenAIEvaluation && (
    options.modelOverrideProvided ||
    env.MOSAIC_OPENAI_MODEL ||
    env.MOSAIC_OPENAI_REASONING_EFFORT
  )) {
    throw new Error(
      "Unpinned OpenAI evaluation refuses --model, MOSAIC_OPENAI_MODEL, or MOSAIC_OPENAI_REASONING_EFFORT overrides"
    );
  }

  const unknownCaseIds = options.caseIds.filter((id) => !cases.some((evalCase) => evalCase.id === id));
  if (unknownCaseIds.length > 0) {
    throw new Error(`Unknown eval case id(s): ${unknownCaseIds.join(", ")}`);
  }

  const selectedCases = options.caseIds.length > 0
    ? cases.filter((evalCase) => options.caseIds.includes(evalCase.id))
    : cases;

  if (selectedCases.length === 0) {
    throw new Error("No eval cases selected");
  }

  if (options.frozenEvaluation) {
    await assertTrackedWorktreeClean();
  }
  await ensureNewOutputDir(options.outputDir);
  const startedAt = Date.now();
  await writeRunMetadata(options, selectedCases, startedAt);

  const caseById = new Map(selectedCases.map((evalCase) => [evalCase.id, evalCase]));
  const trialRuns = createEvalTrialRuns(selectedCases.map((evalCase) => evalCase.id), options.trials);
  const workItems = trialRuns.map((trialRun) => ({
    trialRun,
    evalCase: caseById.get(trialRun.caseId) as EvalCase
  }));
  let remainingBudgetUsd = options.maxCostUsd;
  const batchResults = await runEvalCaseBatch(workItems, {
    timeoutMs: options.caseTimeoutMs,
    getId: ({ trialRun }) => trialRun.runId,
    runCase: async ({ evalCase, trialRun }, signal) => {
      const result = await runCaseInChild(evalCase, trialRun, {
        ...options,
        maxCostUsd: remainingBudgetUsd,
        trial: trialRun.trial,
        runId: trialRun.runId
      }, signal, (usage) => {
        if (remainingBudgetUsd !== undefined) {
          remainingBudgetUsd = Math.max(0, remainingBudgetUsd - resolveCommittedEvalCostUsd(usage));
        }
      });
      if (remainingBudgetUsd !== undefined) {
        remainingBudgetUsd = Math.max(
          0,
          remainingBudgetUsd - (result.usage ? resolveCommittedEvalCostUsd(result.usage) : 0)
        );
      }
      return result;
    }
  });
  const results = batchResults.map((result, index) => ({
    ...result,
    caseId: workItems[index].trialRun.caseId,
    trial: workItems[index].trialRun.trial
  }));
  const finishedAt = Date.now();
  const summary = summarizeEvalTrials(results);
  await writeEvalReport(join(options.outputDir, "results.json"), results, { startedAt, finishedAt }, summary);

  if (!options.keep) {
    await Promise.all(results.map(async (result) => {
      const tempPath = typeof result.tempPath === "string" ? result.tempPath : "";
      if (tempPath) {
        await rm(dirname(tempPath), { recursive: true, force: true });
      }
    }));
  }

  const passed = results.filter((result) => result.passed).length;
  for (const result of results as Array<EvalBatchResult & Partial<EvalResult>>) {
    const status = result.passed ? "PASS" : "FAIL";
    console.log(`${status} ${result.id}`);
    console.log(`  references: ${result.references?.join(", ") || "(none)"}`);
    console.log(`  loaded: ${result.loadedFiles?.join(", ") || "(none)"}`);
    if (result.generated) {
      console.log(`  changed: ${result.changedFiles?.join(", ") || "(none)"}`);
    }
    if (result.errors.length > 0) {
      for (const error of result.errors) {
        console.log(`  - ${error}`);
      }
    }
    if (options.keep) {
      console.log(`  temp: ${result.tempPath ?? "(unavailable)"}`);
    }
    console.log(`  artifacts: ${result.artifactPath ?? join(options.outputDir, result.id)}`);
  }

  console.log(`\n${passed}/${results.length} evals passed`);
  console.log(`pass@1: ${summary.passAt1.passedCases}/${summary.passAt1.totalCases}`);
  console.log(`pass@${options.trials}: ${summary.passAtK.passedCases}/${summary.passAtK.totalCases}`);
  console.log(`JSON report: ${join(options.outputDir, "results.json")}`);
  if (passed !== results.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

export type EvalOutcome = "completed" | "error" | "timeout";

export class EvalCaseExecutionError extends Error {
  constructor(message: string, readonly resultDetails: Record<string, unknown> = {}) {
    super(message);
    this.name = "EvalCaseExecutionError";
  }
}

export const DEFAULT_EVAL_CASE_TIMEOUT_MS = 420_000;

export interface EvalBatchResult {
  id: string;
  passed: boolean;
  outcome: EvalOutcome;
  errors: string[];
  [key: string]: unknown;
}

export interface EvalTrialRun {
  caseId: string;
  trial: number;
  runId: string;
}

export interface EvalTrialSummary {
  totalTrials: number;
  passedTrials: number;
  trialPassRate: number;
  passAt1: { passedCases: number; totalCases: number; rate: number };
  passAtK: { passedCases: number; totalCases: number; rate: number };
  cases: Array<{
    caseId: string;
    passedTrials: number;
    totalTrials: number;
    passAt1: boolean;
    passAtK: boolean;
  }>;
}

export function createEvalTrialRuns(caseIds: string[], trials: number): EvalTrialRun[] {
  const runs: EvalTrialRun[] = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    for (const caseId of caseIds) {
      runs.push({
        caseId,
        trial,
        runId: trials === 1 ? caseId : `${caseId}--trial-${trial}`
      });
    }
  }
  return runs;
}

export function summarizeEvalTrials(results: EvalBatchResult[]): EvalTrialSummary {
  const grouped = new Map<string, EvalBatchResult[]>();
  for (const result of results) {
    const caseId = typeof result.caseId === "string" ? result.caseId : result.id;
    const current = grouped.get(caseId) ?? [];
    current.push(result);
    grouped.set(caseId, current);
  }

  const cases = [...grouped.entries()].map(([caseId, caseResults]) => {
    const sorted = [...caseResults].sort((left, right) =>
      Number(left.trial ?? 1) - Number(right.trial ?? 1)
    );
    const passedTrials = sorted.filter((result) => result.passed).length;
    return {
      caseId,
      passedTrials,
      totalTrials: sorted.length,
      passAt1: sorted[0]?.passed ?? false,
      passAtK: passedTrials > 0
    };
  });
  const totalTrials = results.length;
  const passedTrials = results.filter((result) => result.passed).length;
  const totalCases = cases.length;
  const passAt1Cases = cases.filter((result) => result.passAt1).length;
  const passAtKCases = cases.filter((result) => result.passAtK).length;

  return {
    totalTrials,
    passedTrials,
    trialPassRate: totalTrials === 0 ? 0 : passedTrials / totalTrials,
    passAt1: {
      passedCases: passAt1Cases,
      totalCases,
      rate: totalCases === 0 ? 0 : passAt1Cases / totalCases
    },
    passAtK: {
      passedCases: passAtKCases,
      totalCases,
      rate: totalCases === 0 ? 0 : passAtKCases / totalCases
    },
    cases
  };
}

interface EvalCaseBatchOptions<T> {
  timeoutMs: number;
  runCase: (evalCase: T, signal: AbortSignal) => Promise<{ id: string; passed: boolean; errors?: string[] }>;
  getId?: (evalCase: T) => string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runEvalCaseBatch<T>(
  evalCases: T[],
  options: EvalCaseBatchOptions<T>
): Promise<EvalBatchResult[]> {
  const results: EvalBatchResult[] = [];

  for (const evalCase of evalCases) {
    const id = options.getId ? options.getId(evalCase) : String(evalCase);
    const abortController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort(new Error(`Eval case timed out after ${options.timeoutMs}ms: ${id}`));
    }, options.timeoutMs);

    try {
      const result = await options.runCase(evalCase, abortController.signal);
      results.push({
        ...result,
        id: result.id,
        passed: result.passed,
        outcome: "completed",
        errors: result.errors ?? []
      });
    } catch (error) {
      const resultDetails = error instanceof EvalCaseExecutionError ? error.resultDetails : {};
      results.push({
        ...resultDetails,
        id,
        passed: false,
        outcome: timedOut || abortController.signal.aborted ? "timeout" : "error",
        errors: [errorMessage(error)]
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return results;
}

export async function writeEvalReport(
  outputPath: string,
  results: EvalBatchResult[],
  timing: { startedAt: number; finishedAt: number },
  summary?: EvalTrialSummary
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ ...timing, ...(summary ? { summary } : {}), results }, null, 2)}\n`, "utf8");
}

export interface GeneratedPathPolicy {
  oraclePaths: string[];
  oraclePathPrefixes?: string[];
  generatedTestPathPrefixes: string[];
}

export interface EvalRepairSummary {
  modelAttempts: number;
  deterministicAttempts: number;
  totalAttempts: number;
  stages: string[];
}

export type RawSolutionFailureSurface = "validation" | "verification" | "deterministic-check" | "hidden-oracle";

export function assessRawSolutionOutcome(errors: {
  validation: string[];
  verification: string[];
  deterministicChecks: string[];
  hiddenOracle: string[];
}): { passed: boolean; failureSurface?: RawSolutionFailureSurface } {
  const orderedSurfaces: Array<[RawSolutionFailureSurface, string[]]> = [
    ["validation", errors.validation],
    ["verification", errors.verification],
    ["deterministic-check", errors.deterministicChecks],
    ["hidden-oracle", errors.hiddenOracle]
  ];
  const failureSurface = orderedSurfaces.find(([, surfaceErrors]) => surfaceErrors.length > 0)?.[0];
  return failureSurface ? { passed: false, failureSurface } : { passed: true };
}

export function pathMatchesAnyPattern(path: string, patterns: Array<string | string[]>): boolean {
  return patterns.some((pattern) => {
    const alternatives = Array.isArray(pattern) ? pattern : [pattern];
    return alternatives.some((candidate) => path === candidate || path.includes(candidate));
  });
}

export function validateAllowedChangedPaths(
  changedPaths: string[],
  allowedPatterns: Array<string | string[]>
): string[] {
  return changedPaths
    .filter((path) => !pathMatchesAnyPattern(path, allowedPatterns))
    .map((path) => `Generated change exceeded allowed file containment: ${path}`);
}

export function buildChangedPythonTestCommand(
  changedPaths: string[],
  options: { runner: "unittest" | "pytest"; pytestCommand?: string }
): string | undefined {
  const testPaths = changedPaths
    .filter((path) => path.startsWith("tests/") && path.endsWith(".py"))
    .sort();
  if (testPaths.length === 0) {
    return undefined;
  }

  if (options.runner === "pytest") {
    const command = options.pytestCommand ?? "python3 -m pytest";
    return `${command} ${testPaths.map((path) => JSON.stringify(path)).join(" ")}`;
  }

  const modules = testPaths.map((path) => path.replace(/\.py$/, "").replace(/\//g, "."));
  return `python3 -m unittest ${modules.map((module) => JSON.stringify(module)).join(" ")}`;
}

export function inferChangedPythonTestRunner(
  changes: Array<{ filePath: string; modifiedContent: string }>,
  verificationCommands: string[] = []
): "unittest" | "pytest" | undefined {
  const pythonTests = changes.filter((change) =>
    change.filePath.startsWith("tests/") && change.filePath.endsWith(".py")
  );
  if (pythonTests.length === 0) {
    return undefined;
  }
  if (verificationCommands.some((command) => /\bpytest\b/.test(command)) ||
      pythonTests.some((change) =>
        /(?:^|\n)\s*(?:from\s+pytest\b|import\s+pytest\b)|\bpytest\.|^(?:async\s+)?def\s+test_/m
          .test(change.modifiedContent)
      )) {
    return "pytest";
  }
  return "unittest";
}

export function summarizeRepairAttempts(
  calls: Array<{ phase: string }>,
  validationStages: string[],
  verificationStages: string[]
): EvalRepairSummary {
  const generationCalls = calls.filter((call) => call.phase === "generation-and-repair").length;
  const otherRepairCalls = calls.filter((call) => call.phase === "check-repair").length;
  const modelAttempts = Math.max(0, generationCalls - 1) + otherRepairCalls;
  const stages = [...validationStages, ...verificationStages]
    .filter((stage) => stage.includes("repair"));
  const deterministicAttempts = stages.filter((stage) => stage.includes("deterministic-repair")).length;

  return {
    modelAttempts,
    deterministicAttempts,
    totalAttempts: modelAttempts + deterministicAttempts,
    stages
  };
}

export interface FrontendRepairRequirement {
  assertion: string;
  action: "click" | "keyboard_activate" | "assert" | "runtime";
  selectorAlternatives: string[];
  expectation: {
    kind: "exists" | "text_includes" | "attribute_equals" | "class_any" | "min_count" | "open_state" | "dialog_semantics" | "no_runtime_errors";
    value?: string | number;
    attribute?: string;
    values?: string[];
  };
  actual: Record<string, unknown>;
}

export function formatFrontendRepairRequirement(requirement: FrontendRepairRequirement): string {
  return `Frontend repair requirement: ${JSON.stringify(requirement)}`;
}

const frontendOpenClasses = ["is-open", "is-visible", "active", "modal-overlay--open"] as const;

export interface FrontendElementOpenState {
  hidden: boolean;
  ariaHidden: string | null;
  openAttribute: boolean;
  openClasses: string[];
}

export function captureFrontendElementOpenState(element: Element): FrontendElementOpenState {
  return {
    hidden: element.hasAttribute("hidden"),
    ariaHidden: element.getAttribute("aria-hidden"),
    openAttribute: element.hasAttribute("open"),
    openClasses: frontendOpenClasses.filter((className) => element.classList.contains(className))
  };
}

export function frontendElementIsOpen(
  element: Element,
  previousState?: FrontendElementOpenState
): boolean {
  const currentState = captureFrontendElementOpenState(element);
  if (currentState.hidden || currentState.ariaHidden === "true") {
    return false;
  }

  if (element.tagName.toLowerCase() === "dialog") {
    return currentState.openAttribute;
  }

  if (currentState.ariaHidden !== null) {
    return currentState.ariaHidden === "false";
  }
  if (currentState.openClasses.length > 0) {
    return true;
  }

  return previousState?.hidden === true;
}

export function frontendElementHasDialogSemantics(element: Element): boolean {
  return element.tagName.toLowerCase() === "dialog" || element.getAttribute("role")?.toLowerCase() === "dialog";
}

function pathMatches(path: string, exactPaths: Set<string>, prefixes: string[]): boolean {
  return exactPaths.has(path) || prefixes.some((prefix) => path.startsWith(prefix));
}

export function assertGeneratedPathsAllowed(changedPaths: string[], policy: GeneratedPathPolicy): void {
  const oraclePaths = new Set(policy.oraclePaths);

  for (const changedPath of changedPaths) {
    if (pathMatches(changedPath, oraclePaths, policy.oraclePathPrefixes ?? [])) {
      throw new Error(`Generated change targets immutable oracle path: ${changedPath}`);
    }
    if (changedPath.startsWith("tests/") &&
        !policy.generatedTestPathPrefixes.some((prefix) => changedPath.startsWith(prefix))) {
      throw new Error(`Generated change targets unapproved test path: ${changedPath}`);
    }
  }
}

export function relocateGeneratedTestsFromImmutablePaths<T extends CaseArtifactChange>(
  changes: T[],
  policy: GeneratedPathPolicy
): T[] {
  const oraclePaths = new Set(policy.oraclePaths);
  const generatedPrefix = policy.generatedTestPathPrefixes[0];
  const occupiedPaths = new Set(changes.map((change) => change.filePath));

  return changes.map((change) => {
    if (!pathMatches(change.filePath, oraclePaths, policy.oraclePathPrefixes ?? [])) {
      return change;
    }
    if (change.originalContent.length > 0 || !generatedPrefix) {
      throw new Error(`Generated change targets immutable oracle path: ${change.filePath}`);
    }

    const relocatedPath = `${generatedPrefix}${basename(change.filePath)}`;
    if (occupiedPaths.has(relocatedPath)) {
      throw new Error(`Cannot relocate generated oracle-path test because target already exists: ${relocatedPath}`);
    }
    occupiedPaths.delete(change.filePath);
    occupiedPaths.add(relocatedPath);
    return { ...change, filePath: relocatedPath };
  });
}

export function partitionVisibleContext<T extends { path: string }>(
  files: T[],
  oraclePaths: string[],
  oraclePathPrefixes: string[] = []
): { visible: T[]; oracles: T[] } {
  const immutablePaths = new Set(oraclePaths);
  const visible: T[] = [];
  const oracles: T[] = [];
  for (const file of files) {
    (pathMatches(file.path, immutablePaths, oraclePathPrefixes) ? oracles : visible).push(file);
  }
  return { visible, oracles };
}

export function partitionVerificationCommands(
  commands: string[],
  oraclePaths: string[],
  oraclePathPrefixes: string[] = []
): { visible: string[]; oracles: string[] } {
  const patterns = [...oraclePaths, ...oraclePathPrefixes];
  const visible: string[] = [];
  const oracles: string[] = [];
  for (const command of commands) {
    const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) =>
      token.replace(/^["']|["']$/g, "")
    ) ?? [];
    const targetsOracle = patterns.some((pattern) => {
      const normalizedPattern = pattern.replace(/\/$/, "");
      const normalizedModule = normalizedPattern
        .replace(/\.py$/, "")
        .replaceAll("/", ".");
      return tokens.some((token) =>
        token === normalizedPattern ||
        token.startsWith(`${normalizedPattern}/`) ||
        token === normalizedModule ||
        token.startsWith(`${normalizedModule}.`)
      );
    });
    (targetsOracle ? oracles : visible).push(command);
  }
  return { visible, oracles };
}

interface PlanWithRequiredFiles {
  requiredFiles: Array<{ path: string; reason: string }>;
  acceptanceCriteria: string[];
  implementationChecklist: string[];
  verificationChecklist: string[];
  verificationCommands: string[];
}

export function sanitizePlanForImmutablePaths<T extends PlanWithRequiredFiles>(
  plan: T,
  policy: GeneratedPathPolicy
): T {
  const oraclePaths = new Set(policy.oraclePaths);
  const replacements = new Map<string, string>();
  const requiredFiles: Array<{ path: string; reason: string }> = [];

  for (const file of plan.requiredFiles) {
    const targetsOracle = pathMatches(file.path, oraclePaths, policy.oraclePathPrefixes ?? []);
    const targetsUnapprovedTest = file.path.startsWith("tests/") &&
      !policy.generatedTestPathPrefixes.some((prefix) => file.path.startsWith(prefix));
    if (!targetsOracle && !targetsUnapprovedTest) {
      requiredFiles.push(file);
      continue;
    }

    const generatedPrefix = policy.generatedTestPathPrefixes[0];
    if (!generatedPrefix) {
      continue;
    }
    const replacementPath = `${generatedPrefix}${basename(file.path)}`;
    replacements.set(file.path, replacementPath);
    if (!requiredFiles.some((requiredFile) => requiredFile.path === replacementPath)) {
      requiredFiles.push({
        path: replacementPath,
        reason: "Add independent generated regression coverage; verification-only tests remain immutable"
      });
    }
  }

  const replaceImmutablePaths = (text: string): string => {
    let sanitized = text;
    for (const [oraclePath, replacementPath] of replacements) {
      sanitized = sanitized.replaceAll(oraclePath, replacementPath);
      if (oraclePath.endsWith(".py") && replacementPath.endsWith(".py")) {
        const oracleModule = oraclePath.replace(/\.py$/, "").replace(/\//g, ".");
        const replacementModule = replacementPath.replace(/\.py$/, "").replace(/\//g, ".");
        sanitized = sanitized.replaceAll(oracleModule, replacementModule);
      }
    }
    return sanitized;
  };

  return {
    ...plan,
    requiredFiles,
    acceptanceCriteria: plan.acceptanceCriteria.map(replaceImmutablePaths),
    implementationChecklist: plan.implementationChecklist.map(replaceImmutablePaths),
    verificationChecklist: plan.verificationChecklist.map(replaceImmutablePaths),
    verificationCommands: plan.verificationCommands.map(replaceImmutablePaths)
  };
}

interface CaseArtifactChange {
  filePath: string;
  originalContent: string;
  modifiedContent: string;
  explanation: string;
}

interface CaseArtifacts {
  plan: unknown;
  selectedContext: unknown;
  changes: CaseArtifactChange[];
  validationHistory: unknown;
  validationCandidates: Array<{
    stage: string;
    selected: boolean;
    changes: CaseArtifactChange[];
  }>;
  verificationHistory: unknown;
}

function contentLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const withoutFinalNewline = content.endsWith("\n") ? content.slice(0, -1) : content;
  return withoutFinalNewline.split("\n");
}

function formatFinalDiff(changes: CaseArtifactChange[]): string {
  return changes.map((change) => {
    const originalLines = contentLines(change.originalContent);
    const modifiedLines = contentLines(change.modifiedContent);
    const lines = [
      `--- a/${change.filePath}`,
      `+++ b/${change.filePath}`,
      `@@ -1,${originalLines.length} +1,${modifiedLines.length} @@`,
      ...originalLines.map((line) => `-${line}`),
      ...modifiedLines.map((line) => `+${line}`)
    ];
    return lines.join("\n");
  }).join("\n") + (changes.length > 0 ? "\n" : "");
}

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export async function writeCaseArtifacts(outputDir: string, artifacts: CaseArtifacts): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeJsonAtomically(`${outputDir}/plan.json`, artifacts.plan),
    writeJsonAtomically(`${outputDir}/selected-context.json`, artifacts.selectedContext),
    writeJsonAtomically(`${outputDir}/change-manifest.json`, artifacts.changes),
    writeJsonAtomically(`${outputDir}/validation-history.json`, artifacts.validationHistory),
    writeJsonAtomically(`${outputDir}/validation-candidates.json`, artifacts.validationCandidates),
    writeJsonAtomically(`${outputDir}/verification-history.json`, artifacts.verificationHistory),
    writeFile(`${outputDir}/final.diff`, formatFinalDiff(artifacts.changes), "utf8")
  ]);
}

export interface EvalUsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

export interface EvalBudgetReservation {
  id: string;
  estimatedMaxCostUsd: number;
  status: "outstanding" | "settled";
  observedCostUsd?: number;
}

export interface EvalBudgetSnapshot {
  observedCostUsd: number;
  outstandingReservedCostUsd: number;
  committedCostUsd: number;
  reservations: EvalBudgetReservation[];
}

export interface ModelPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
  cacheCreationUsdPerMillion: number;
  inputTokensIncludeCacheReads?: boolean;
}

export interface UsageTokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ModelUsageIteration extends UsageTokenCounts {
  type: "message" | "advisor_message";
  model: string;
}

export function calculateUsageCostUsd(usage: UsageTokenCounts, pricing: ModelPricing): number {
  const uncachedInputTokens = pricing.inputTokensIncludeCacheReads
    ? Math.max(0, usage.inputTokens - usage.cacheReadInputTokens)
    : usage.inputTokens;
  return (
    uncachedInputTokens * pricing.inputUsdPerMillion +
    usage.outputTokens * pricing.outputUsdPerMillion +
    usage.cacheReadInputTokens * pricing.cacheReadUsdPerMillion +
    usage.cacheCreationInputTokens * pricing.cacheCreationUsdPerMillion
  ) / 1_000_000;
}

export function calculateUsageIterationsCostUsd(
  iterations: ModelUsageIteration[],
  pricing: Record<string, ModelPricing>
): number {
  return iterations.reduce((total, iteration) => {
    const modelPricing = pricing[iteration.model];
    if (!modelPricing) {
      throw new Error(`Missing pricing for model: ${iteration.model}`);
    }
    return total + calculateUsageCostUsd(iteration, modelPricing);
  }, 0);
}

function extractTopLevelPythonSymbols(content: string): Map<string, string> {
  const lines = content.split("\n");
  const symbols = new Map<string, string>();
  let currentName: string | undefined;
  let currentLines: string[] = [];

  const finish = (): void => {
    if (currentName) {
      symbols.set(currentName, currentLines.join("\n").trimEnd());
    }
  };

  for (const line of lines) {
    const match = line.match(/^(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
    if (match) {
      finish();
      currentName = match[1];
      currentLines = [line];
    } else if (currentName) {
      currentLines.push(line);
    }
  }
  finish();
  return symbols;
}

function extractTopLevelJavaScriptSymbols(content: string): Map<string, string> {
  const lines = content.split("\n");
  const symbols = new Map<string, string>();

  for (let start = 0; start < lines.length; start += 1) {
    const line = lines[start];
    const declaration = line.match(
      /^(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b|(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)/
    );
    const name = declaration?.[1] ?? declaration?.[2];
    if (!name) {
      continue;
    }

    const symbolLines: string[] = [];
    let braceDepth = 0;
    let sawBrace = false;
    let end = start;
    for (; end < lines.length; end += 1) {
      const symbolLine = lines[end];
      symbolLines.push(symbolLine);
      for (const character of symbolLine) {
        if (character === "{") {
          braceDepth += 1;
          sawBrace = true;
        } else if (character === "}") {
          braceDepth -= 1;
        }
      }

      if ((sawBrace && braceDepth === 0) || (!sawBrace && /;\s*$/.test(symbolLine))) {
        break;
      }
    }

    symbols.set(name, symbolLines.join("\n").trimEnd());
    start = end;
  }

  return symbols;
}

export function validateUnchangedSymbols(
  change: { filePath: string; originalContent: string; modifiedContent: string },
  unchangedSymbols: string[]
): string[] {
  const isPython = change.filePath.toLowerCase().endsWith(".py");
  const originalSymbols = isPython
    ? extractTopLevelPythonSymbols(change.originalContent)
    : extractTopLevelJavaScriptSymbols(change.originalContent);
  const modifiedSymbols = isPython
    ? extractTopLevelPythonSymbols(change.modifiedContent)
    : extractTopLevelJavaScriptSymbols(change.modifiedContent);
  return unchangedSymbols.flatMap((symbol) =>
    originalSymbols.get(symbol) === modifiedSymbols.get(symbol)
      ? []
      : [`Unrelated protected symbol changed in ${change.filePath}: ${symbol}`]
  );
}

export function validateUnchangedSymbolsWithAllowedLines(
  change: { filePath: string; originalContent: string; modifiedContent: string },
  allowedBySymbol: Record<string, string[]>
): string[] {
  const isPython = change.filePath.toLowerCase().endsWith(".py");
  const originalSymbols = isPython
    ? extractTopLevelPythonSymbols(change.originalContent)
    : extractTopLevelJavaScriptSymbols(change.originalContent);
  const modifiedSymbols = isPython
    ? extractTopLevelPythonSymbols(change.modifiedContent)
    : extractTopLevelJavaScriptSymbols(change.modifiedContent);

  return Object.entries(allowedBySymbol).flatMap(([symbol, allowedTokens]) => {
    const original = originalSymbols.get(symbol);
    let modified = modifiedSymbols.get(symbol);
    if (original === undefined || modified === undefined) {
      return [`Unrelated protected symbol changed in ${change.filePath}: ${symbol}`];
    }
    for (const token of allowedTokens) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      modified = modified
        .split("\n")
        .filter((line) => line.trim().replace(/,$/, "") !== token)
        .join("\n")
        .replace(new RegExp(`,\\s*${escaped}`, "g"), "")
        .replace(new RegExp(`${escaped}\\s*,\\s*`, "g"), "");
    }
    return original === modified
      ? []
      : [`Unrelated protected symbol changed in ${change.filePath}: ${symbol}`];
  });
}

export function validateUnchangedPythonSymbols(
  change: { filePath: string; originalContent: string; modifiedContent: string },
  unchangedSymbols: string[]
): string[] {
  return validateUnchangedSymbols(change, unchangedSymbols);
}

export function estimateMaximumCallCostUsd(
  estimatedInputTokens: number,
  maxOutputTokens: number,
  pricing: ModelPricing
): number {
  return calculateUsageCostUsd({
    inputTokens: estimatedInputTokens,
    outputTokens: maxOutputTokens,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0
  }, pricing);
}

export function estimateMaximumAdvisorCallCostUsd(
  estimatedExecutorInputTokens: number,
  executorMaxOutputTokens: number,
  advisorMaxOutputTokens: number,
  pricing: ModelPricing
): number {
  return estimateMaximumCallCostUsd(
    estimatedExecutorInputTokens + executorMaxOutputTokens,
    advisorMaxOutputTokens,
    pricing
  );
}

export class EvalBudget {
  private observedCostUsd = 0;
  private nextReservationNumber = 1;
  private readonly reservations = new Map<string, EvalBudgetReservation>();

  constructor(private readonly maxCostUsd: number) {
    if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
      throw new Error("Evaluation budget must be a non-negative finite number");
    }
  }

  authorize({ estimatedMaxCostUsd }: { estimatedMaxCostUsd: number }): string {
    if (estimatedMaxCostUsd < 0 || !Number.isFinite(estimatedMaxCostUsd)) {
      throw new Error("Estimated request cost must be a non-negative finite number");
    }
    if (this.committedCostUsd + estimatedMaxCostUsd > this.maxCostUsd) {
      throw new Error(
        `Evaluation budget exhausted: $${this.observedCostUsd.toFixed(6)} observed, ` +
        `$${this.outstandingReservedCostUsd.toFixed(6)} reserved, ` +
        `$${estimatedMaxCostUsd.toFixed(6)} maximum next-call cost, $${this.maxCostUsd.toFixed(6)} limit`
      );
    }

    const id = `eval-request-${this.nextReservationNumber}`;
    this.nextReservationNumber += 1;
    this.reservations.set(id, {
      id,
      estimatedMaxCostUsd,
      status: "outstanding"
    });
    return id;
  }

  record(record: EvalUsageRecord, reservationId?: string): void {
    if (record.costUsd < 0 || !Number.isFinite(record.costUsd)) {
      throw new Error("Recorded request cost must be a non-negative finite number");
    }

    if (reservationId) {
      const reservation = this.reservations.get(reservationId);
      if (!reservation) {
        throw new Error(`Unknown evaluation budget reservation: ${reservationId}`);
      }
      if (reservation.status !== "outstanding") {
        throw new Error(`Evaluation budget reservation was already settled: ${reservationId}`);
      }
      reservation.status = "settled";
      reservation.observedCostUsd = record.costUsd;
    }

    this.observedCostUsd += record.costUsd;
  }

  get totalCostUsd(): number {
    return this.observedCostUsd;
  }

  get outstandingReservedCostUsd(): number {
    return [...this.reservations.values()].reduce(
      (total, reservation) => reservation.status === "outstanding"
        ? total + reservation.estimatedMaxCostUsd
        : total,
      0
    );
  }

  get committedCostUsd(): number {
    return this.observedCostUsd + this.outstandingReservedCostUsd;
  }

  snapshot(): EvalBudgetSnapshot {
    return {
      observedCostUsd: this.observedCostUsd,
      outstandingReservedCostUsd: this.outstandingReservedCostUsd,
      committedCostUsd: this.committedCostUsd,
      reservations: [...this.reservations.values()].map((reservation) => ({ ...reservation }))
    };
  }
}

export function resolveCommittedEvalCostUsd(usage: {
  totalCostUsd: number;
  committedCostUsd?: number;
}): number {
  return usage.committedCostUsd ?? usage.totalCostUsd;
}

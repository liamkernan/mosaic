import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type EvalOutcome = "completed" | "error" | "timeout";

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
      results.push({
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

export interface FrontendRepairRequirement {
  assertion: string;
  action: "click" | "keyboard_activate" | "assert" | "runtime";
  selectorAlternatives: string[];
  expectation: {
    kind: "exists" | "text_includes" | "attribute_equals" | "class_any" | "min_count" | "no_runtime_errors";
    value?: string | number;
    attribute?: string;
    values?: string[];
  };
  actual: Record<string, unknown>;
}

export function formatFrontendRepairRequirement(requirement: FrontendRepairRequirement): string {
  return `Frontend repair requirement: ${JSON.stringify(requirement)}`;
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeCaseArtifacts(outputDir: string, artifacts: CaseArtifacts): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeJson(`${outputDir}/plan.json`, artifacts.plan),
    writeJson(`${outputDir}/selected-context.json`, artifacts.selectedContext),
    writeJson(`${outputDir}/change-manifest.json`, artifacts.changes),
    writeJson(`${outputDir}/validation-history.json`, artifacts.validationHistory),
    writeJson(`${outputDir}/verification-history.json`, artifacts.verificationHistory),
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

export interface ModelPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
  cacheCreationUsdPerMillion: number;
}

export interface UsageTokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export function calculateUsageCostUsd(usage: UsageTokenCounts, pricing: ModelPricing): number {
  return (
    usage.inputTokens * pricing.inputUsdPerMillion +
    usage.outputTokens * pricing.outputUsdPerMillion +
    usage.cacheReadInputTokens * pricing.cacheReadUsdPerMillion +
    usage.cacheCreationInputTokens * pricing.cacheCreationUsdPerMillion
  ) / 1_000_000;
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

export function validateUnchangedPythonSymbols(
  change: { filePath: string; originalContent: string; modifiedContent: string },
  unchangedSymbols: string[]
): string[] {
  const originalSymbols = extractTopLevelPythonSymbols(change.originalContent);
  const modifiedSymbols = extractTopLevelPythonSymbols(change.modifiedContent);
  return unchangedSymbols.flatMap((symbol) =>
    originalSymbols.get(symbol) === modifiedSymbols.get(symbol)
      ? []
      : [`Unrelated protected symbol changed in ${change.filePath}: ${symbol}`]
  );
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

export class EvalBudget {
  private spentUsd = 0;

  constructor(private readonly maxCostUsd: number) {
    if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
      throw new Error("Evaluation budget must be a non-negative finite number");
    }
  }

  authorize({ estimatedMaxCostUsd }: { estimatedMaxCostUsd: number }): void {
    if (estimatedMaxCostUsd < 0 || !Number.isFinite(estimatedMaxCostUsd)) {
      throw new Error("Estimated request cost must be a non-negative finite number");
    }
    if (this.spentUsd + estimatedMaxCostUsd > this.maxCostUsd) {
      throw new Error(
        `Evaluation budget exhausted: $${this.spentUsd.toFixed(6)} spent, ` +
        `$${estimatedMaxCostUsd.toFixed(6)} maximum next-call cost, $${this.maxCostUsd.toFixed(6)} limit`
      );
    }
  }

  record(record: EvalUsageRecord): void {
    if (record.costUsd < 0 || !Number.isFinite(record.costUsd)) {
      throw new Error("Recorded request cost must be a non-negative finite number");
    }
    this.spentUsd += record.costUsd;
  }

  get totalCostUsd(): number {
    return this.spentUsd;
  }
}

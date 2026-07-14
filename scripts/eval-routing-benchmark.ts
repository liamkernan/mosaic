import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { getEnv } from "../packages/core/src/config.js";
import { assessFeedbackContent } from "../packages/intake/src/abuse-protection.js";
import {
  LLMClient,
  type LLMRequestAuthorization,
  type LLMUsageObservation
} from "../packages/llm/src/client.js";
import { resolveOpenAIBaseURL } from "../packages/llm/src/openai.js";
import type { OpenAIClassificationPass } from "../packages/pipeline/src/classification-routing.js";
import type { OpenAIModelSelection } from "../packages/pipeline/src/model-routing.js";
import {
  EvalBudget,
  calculateUsageCostUsd,
  calculateUsageIterationsCostUsd,
  estimateMaximumCallCostUsd,
  type ModelPricing
} from "./eval-local-fixes-support.js";
import {
  runUnscoredRoutingCase,
  scoreRoutingResults,
  type RoutingBenchmarkExpectationsFile,
  type RoutingBenchmarkInputsFile,
  type RoutingBenchmarkSplit,
  type UnscoredRoutingResult
} from "./eval-routing-benchmark-support.js";

const execFile = promisify(execFileCallback);
const inputsPath = "evals/gpt-5.6-routing-benchmark-2026-07-14.inputs.json";
const expectationsPath = "evals/gpt-5.6-routing-benchmark-2026-07-14.expected.json";
const benchmarkFreezeCommit = "e443bff";

type PricingTable = Record<string, ModelPricing>;

interface RoutingUsageCall extends LLMUsageObservation {
  caseId: string;
  passIndex: number;
  intendedRoute: OpenAIModelSelection;
  costUsd: number;
  iterations: Array<LLMUsageObservation["iterations"][number] & { costUsd: number }>;
}

interface CliOptions {
  split: RoutingBenchmarkSplit;
  caseIds: string[];
  outputDir: string;
  pricingPath?: string;
  maxCostUsd?: number;
  acknowledgeHoldout: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const options: CliOptions = {
    split: "development",
    caseIds: [],
    outputDir: resolve("evals", "runs", timestamp + "-gpt-5.6-routing-development"),
    acknowledgeHoldout: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--split") {
      const split = argv[++index];
      if (split !== "development" && split !== "holdout") {
        throw new Error("--split must be development or holdout");
      }
      options.split = split;
    } else if (arg === "--case") {
      options.caseIds.push(argv[++index]);
    } else if (arg === "--output-dir") {
      options.outputDir = resolve(argv[++index]);
    } else if (arg === "--pricing") {
      options.pricingPath = resolve(argv[++index]);
    } else if (arg === "--max-cost-usd") {
      options.maxCostUsd = Number(argv[++index]);
      if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0) {
        throw new Error("--max-cost-usd must be a positive number");
      }
    } else if (arg === "--acknowledge-untouched-holdout") {
      options.acknowledgeHoldout = true;
    } else {
      throw new Error("Unknown argument: " + arg);
    }
  }

  if (!options.pricingPath || options.maxCostUsd === undefined) {
    throw new Error("Live routing evaluation requires --pricing and --max-cost-usd");
  }
  if (options.split === "holdout" && !options.acknowledgeHoldout) {
    throw new Error("Holdout execution requires --acknowledge-untouched-holdout");
  }
  if (options.split === "holdout" && options.caseIds.length > 0) {
    throw new Error("Holdout execution must run the complete split, not selected --case values");
  }

  if (!argv.includes("--output-dir")) {
    options.outputDir = options.outputDir.replace(/routing-development$/, "routing-" + options.split);
  }
  return options;
}

async function ensureNewOutputDir(outputDir: string): Promise<void> {
  try {
    await access(outputDir);
    throw new Error("Output directory already exists: " + outputDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(outputDir, { recursive: true });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function gitRevision(revision = "HEAD"): Promise<string> {
  const { stdout } = await execFile("git", ["rev-parse", revision], { cwd: process.cwd() });
  return stdout.trim();
}

async function assertBenchmarkStillFrozen(): Promise<string> {
  const frozenRevision = await gitRevision(benchmarkFreezeCommit);
  try {
    await execFile("git", [
      "diff",
      "--quiet",
      frozenRevision,
      "--",
      inputsPath,
      expectationsPath
    ], { cwd: process.cwd() });
  } catch {
    throw new Error("Frozen routing benchmark definitions differ from commit " + frozenRevision);
  }
  return frozenRevision;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usageSummary(calls: RoutingUsageCall[]): {
  calls: RoutingUsageCall[];
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  latencyMs: number;
  costUsd: number;
} {
  return calls.reduce((summary, call) => ({
    calls,
    callCount: summary.callCount + 1,
    inputTokens: summary.inputTokens + call.iterations.reduce((total, item) => total + item.inputTokens, 0),
    outputTokens: summary.outputTokens + call.iterations.reduce((total, item) => total + item.outputTokens, 0),
    cacheReadInputTokens: summary.cacheReadInputTokens + call.iterations.reduce((total, item) => total + item.cacheReadInputTokens, 0),
    cacheCreationInputTokens: summary.cacheCreationInputTokens + call.iterations.reduce((total, item) => total + item.cacheCreationInputTokens, 0),
    latencyMs: summary.latencyMs + call.latencyMs,
    costUsd: summary.costUsd + call.costUsd
  }), {
    calls,
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    latencyMs: 0,
    costUsd: 0
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const env = getEnv();
  if (env.MOSAIC_OPENAI_MODEL || env.MOSAIC_OPENAI_REASONING_EFFORT) {
    throw new Error("Routing benchmark refuses MOSAIC_OPENAI_MODEL or MOSAIC_OPENAI_REASONING_EFFORT overrides");
  }
  const platformApiKey = env.AZURE_OPENAI_API_KEY ?? env.OPENAI_API_KEY;
  if (!platformApiKey) {
    throw new Error("OPENAI_API_KEY or AZURE_OPENAI_API_KEY is required");
  }

  const [frozenRevision, currentRevision, inputsRaw, pricingRaw] = await Promise.all([
    assertBenchmarkStillFrozen(),
    gitRevision(),
    readFile(inputsPath, "utf8"),
    readFile(options.pricingPath ?? "", "utf8")
  ]);
  const inputs = JSON.parse(inputsRaw) as RoutingBenchmarkInputsFile;
  const pricing = JSON.parse(pricingRaw) as PricingTable;
  const selectedCases = inputs.cases.filter((inputCase) =>
    inputCase.split === options.split &&
    (options.caseIds.length === 0 || options.caseIds.includes(inputCase.id))
  );
  if (selectedCases.length === 0) {
    throw new Error("No benchmark cases selected");
  }
  const unknownCaseIds = options.caseIds.filter((id) => !selectedCases.some((item) => item.id === id));
  if (unknownCaseIds.length > 0) {
    throw new Error("Unknown or wrong-split case id(s): " + unknownCaseIds.join(", "));
  }

  await ensureNewOutputDir(options.outputDir);
  const startedAt = Date.now();
  const budget = new EvalBudget(options.maxCostUsd ?? 0);
  const calls: RoutingUsageCall[] = [];
  const unscoredResults: UnscoredRoutingResult[] = [];
  await writeJson(join(options.outputDir, "run-metadata.json"), {
    benchmarkId: inputs.benchmarkId,
    split: options.split,
    caseIds: selectedCases.map((item) => item.id),
    benchmarkFreezeCommit: frozenRevision,
    codeCommit: currentRevision,
    maxCostUsd: options.maxCostUsd,
    pricingPath: options.pricingPath,
    provider: "openai",
    preset: "quality",
    routeOverrides: { model: null, reasoningEffort: null },
    openAIMinOutputTokens: env.MOSAIC_OPENAI_MIN_OUTPUT_TOKENS ?? null,
    openAIMinTimeoutMs: env.MOSAIC_OPENAI_MIN_TIMEOUT_MS ?? null,
    startedAt
  });

  const authorize = (request: LLMRequestAuthorization): void => {
    const modelPricing = pricing[request.model];
    if (!modelPricing) {
      throw new Error("Missing pricing for model: " + request.model);
    }
    budget.authorize({
      estimatedMaxCostUsd: estimateMaximumCallCostUsd(
        request.estimatedInputTokens,
        request.maxOutputTokens,
        modelPricing
      )
    });
  };

  for (const inputCase of selectedCases) {
    let passIndex = 0;
    const completedPasses: OpenAIClassificationPass[] = [];
    const createClient = (route: OpenAIModelSelection): LLMClient => {
      passIndex += 1;
      const currentPassIndex = passIndex;
      return new LLMClient({
        provider: "openai",
        mode: "platform",
        platformApiKey,
        openAIBaseURL: resolveOpenAIBaseURL(env.OPENAI_BASE_URL, env.AZURE_OPENAI_ENDPOINT),
        openAIMinOutputTokens: env.MOSAIC_OPENAI_MIN_OUTPUT_TOKENS,
        openAIMinTimeoutMs: env.MOSAIC_OPENAI_MIN_TIMEOUT_MS,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        disableUsageTracking: true,
        authorizeRequest: authorize,
        observeUsage: async (event) => {
          const costUsd = calculateUsageIterationsCostUsd(event.iterations, pricing);
          const iterations = event.iterations.map((iteration) => ({
            ...iteration,
            costUsd: calculateUsageCostUsd(iteration, pricing[iteration.model])
          }));
          budget.record({
            model: event.model,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheReadInputTokens: event.cacheReadInputTokens,
            cacheCreationInputTokens: event.cacheCreationInputTokens,
            costUsd
          });
          calls.push({
            ...event,
            caseId: inputCase.id,
            passIndex: currentPassIndex,
            intendedRoute: route,
            costUsd,
            iterations
          });
          await writeJson(join(options.outputDir, "usage.json"), usageSummary(calls));
        }
      });
    };

    try {
      unscoredResults.push(await runUnscoredRoutingCase({
        inputCase,
        createClient,
        onClassificationPass: (pass) => completedPasses.push(pass)
      }));
    } catch (error) {
      unscoredResults.push({
        id: inputCase.id,
        split: inputCase.split,
        domain: inputCase.domain,
        boundaryPairId: inputCase.boundaryPairId,
        status: "error",
        safetyAssessment: assessFeedbackContent(inputCase.rawContent),
        classificationPasses: completedPasses,
        actualRouteKey: "error",
        error: errorMessage(error)
      });
    }
    await writeJson(join(options.outputDir, "unscored-results.json"), {
      benchmarkId: inputs.benchmarkId,
      split: options.split,
      results: unscoredResults
    });
  }

  const expectedRaw = await readFile(expectationsPath, "utf8");
  const expected = JSON.parse(expectedRaw) as RoutingBenchmarkExpectationsFile;
  if (expected.benchmarkId !== inputs.benchmarkId || expected.frozenAt !== inputs.frozenAt) {
    throw new Error("Benchmark inputs and expectations do not match");
  }
  const selectedExpectations = expected.expectations.filter((item) =>
    selectedCases.some((inputCase) => inputCase.id === item.id)
  );
  const scored = scoreRoutingResults(unscoredResults, selectedExpectations);
  const finishedAt = Date.now();
  const totalUsage = usageSummary(calls);
  const resultsWithUsage = scored.results.map((result) => ({
    ...result,
    usage: usageSummary(calls.filter((call) => call.caseId === result.id))
  }));
  const report = {
    benchmarkId: inputs.benchmarkId,
    split: options.split,
    benchmarkFreezeCommit: frozenRevision,
    codeCommit: currentRevision,
    startedAt,
    finishedAt,
    wallTimeMs: finishedAt - startedAt,
    maxCostUsd: options.maxCostUsd,
    summary: {
      ...scored.summary,
      usage: totalUsage
    },
    results: resultsWithUsage
  };
  await writeJson(join(options.outputDir, "results.json"), report);

  process.stdout.write(JSON.stringify({
    outputDir: options.outputDir,
    split: options.split,
    passedCases: scored.summary.passedCases,
    totalCases: scored.summary.totalCases,
    safeRouteAccuracy: scored.summary.safeRoute.accuracy,
    reviewAccuracy: scored.summary.review.accuracy,
    underRoutingCount: scored.summary.underRoutingCount,
    overRoutingCount: scored.summary.overRoutingCount,
    callCount: totalUsage.callCount,
    costUsd: totalUsage.costUsd,
    latencyMs: totalUsage.latencyMs,
    wallTimeMs: finishedAt - startedAt
  }, null, 2) + "\n");
}

const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMainModule) {
  void main().catch((error) => {
    process.stderr.write(errorMessage(error) + "\n");
    process.exitCode = 1;
  });
}

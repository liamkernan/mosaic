import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { assessFeedbackContent } from "../packages/intake/src/abuse-protection.js";
import {
  containsProtectedModelVisiblePath,
  sanitizeImplementationPlanForModel
} from "../packages/pipeline/src/implementation-plan-sanitizer.js";
import { partitionVerificationCommands } from "../scripts/eval-local-fixes-support.js";

const execFile = promisify(execFileCallback);
const manifestPath = "evals/gpt-5.6-protected-request-boundary-confirmation-manifest-2026-07-15.json";
const protocolPath = "evals/GPT_5_6_PROTECTED_REQUEST_BOUNDARY_CONFIRMATION_PROTOCOL_2026_07_15.md";

interface SourceCase {
  id: string;
  fixturePath: string;
  feedback: {
    rawContent: string;
    relevantFiles: string[];
  };
  expectedOpenAIRoute: {
    model: string;
    reasoningEffort: string;
  };
  expectedReferenceFiles: string[];
  oracleTestPathPrefixes: string[];
  generatedTestPathPrefixes: string[];
  verificationCommands: string[];
  runChangedPythonTests: boolean;
  model?: string;
  reasoningEffort?: string;
}

interface ProofManifest {
  schemaVersion: number;
  proofId: string;
  proofKind: string;
  status: string;
  implementationUnderTest: {
    commit: string;
    report: string;
  };
  frozenInputs: {
    casesPath: string;
    casesSha256: string;
    fixturePath: string;
    fixtureSha256: string;
    pricingPath: string;
    pricingSha256: string;
    visibleFixtureReferences: string[];
  };
  protectedPathPolicy: {
    protectedPaths: string[];
    protectedPathPrefixes: string[];
    generatedTestPathPrefixes: string[];
    canonicalization: string;
  };
  run: {
    provider: string;
    preset: string;
    trialsPerCase: number;
    caseCount: number;
    caseIds: string[];
    modelOverride: string | null;
    reasoningEffortOverride: string | null;
    openAIMinOutputTokens: number;
    routeTimeoutFloorsMs: Record<string, number>;
    caseTimeoutMs: number;
    maxCostUsd: number;
    outputDir: string;
  };
  cases: Array<{
    id: string;
    label: string;
    caseInputSha256: string;
    expectedAutomaticRoute: {
      model: string;
      reasoningEffort: string;
    };
    plannerCorrectionAdversary?: {
      nestedPlanFields: string[];
      requiredBoundaryOutcome: string;
    };
    visibleAcceptanceCriteria: string[];
  }>;
  predeclaredSuccessCriteria: string[];
  forbiddenRepairDiagnostics: string[];
  integrityStopRules: string[];
  requiredReporting: string[];
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
      for (const entry of (await readdir(currentPath)).sort()) {
        await visit(join(currentPath, entry));
      }
    } else {
      hash.update(await readFile(currentPath));
    }
  };
  await visit(root);
  return hash.digest("hex");
}

async function loadManifest(): Promise<ProofManifest> {
  return JSON.parse(await readFile(manifestPath, "utf8")) as ProofManifest;
}

async function loadCases(manifest: ProofManifest): Promise<SourceCase[]> {
  return JSON.parse(await readFile(manifest.frozenInputs.casesPath, "utf8")) as SourceCase[];
}

async function unittestExitCode(fixturePath: string, module: string): Promise<number> {
  try {
    await execFile("python3", ["-m", "unittest", module], {
      cwd: resolve(fixturePath),
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
    });
    return 0;
  } catch (error) {
    return (error as { code?: number }).code ?? -1;
  }
}

describe("frozen GPT-5.6 protected-request boundary paid confirmation", () => {
  it("pins the implementation, two-case inputs, fixture, policy, pricing, transport floor, and shared cap", async () => {
    const manifest = await loadManifest();

    expect(manifest).toEqual(expect.objectContaining({
      schemaVersion: 1,
      proofId: "gpt-5.6-protected-request-boundary-confirmation-2026-07-15",
      proofKind: "non-holdout-two-case-confirmation",
      status: "predeclared-before-paid-execution"
    }));
    expect(manifest.implementationUnderTest).toEqual({
      commit: "be8667c72774519388bfe4a94939fd325fd0d602",
      report: "evals/GPT_5_6_PROTECTED_PLAN_PATH_ISOLATION_FIX_2026_07_15.md"
    });
    await expect(sha256File(manifest.frozenInputs.casesPath)).resolves.toBe(manifest.frozenInputs.casesSha256);
    await expect(sha256Path(manifest.frozenInputs.fixturePath)).resolves.toBe(manifest.frozenInputs.fixtureSha256);
    await expect(sha256File(manifest.frozenInputs.pricingPath)).resolves.toBe(manifest.frozenInputs.pricingSha256);
    expect(manifest.protectedPathPolicy).toEqual({
      protectedPaths: [],
      protectedPathPrefixes: ["tests/baseline/", "tests/oracle/"],
      generatedTestPathPrefixes: ["tests/generated/"],
      canonicalization: "case-insensitive slash, backslash, and dotted-module normalization"
    });
    expect(manifest.run).toEqual(expect.objectContaining({
      provider: "openai",
      preset: "quality",
      trialsPerCase: 1,
      caseCount: 2,
      modelOverride: null,
      reasoningEffortOverride: null,
      openAIMinOutputTokens: 49_152,
      routeTimeoutFloorsMs: {
        "gpt-5.6-sol/high": 300_000,
        "gpt-5.6-sol/xhigh": 480_000
      },
      caseTimeoutMs: 900_000,
      maxCostUsd: 3
    }));
  });

  it("selects exactly the retained details-state case and fresh adversarial planner case with rubric-derived routes", async () => {
    const manifest = await loadManifest();
    const sourceCases = await loadCases(manifest);

    expect(manifest.run.caseIds).toEqual([
      "protected-boundary-retained-moderate-safe-details-state",
      "protected-boundary-fresh-planner-correction-incident-summary"
    ]);
    expect(sourceCases.map(({ id }) => id)).toEqual(manifest.run.caseIds);
    expect(manifest.cases.map(({ id }) => id)).toEqual(manifest.run.caseIds);
    expect(sourceCases.map(({ expectedOpenAIRoute }) => expectedOpenAIRoute)).toEqual(
      manifest.cases.map(({ expectedAutomaticRoute }) => expectedAutomaticRoute)
    );
    expect(sourceCases.map(({ expectedOpenAIRoute }) => expectedOpenAIRoute)).toEqual([
      { model: "gpt-5.6-terra", reasoningEffort: "xhigh" },
      { model: "gpt-5.6-terra", reasoningEffort: "xhigh" }
    ]);
    for (const [index, sourceCase] of sourceCases.entries()) {
      expect(sourceCase.fixturePath).toBe(manifest.frozenInputs.fixturePath);
      expect(sourceCase.model).toBeUndefined();
      expect(sourceCase.reasoningEffort).toBeUndefined();
      expect(createHash("sha256").update(JSON.stringify(sourceCase.feedback)).digest("hex"))
        .toBe(manifest.cases[index]?.caseInputSha256);
    }
    expect(manifest.cases[1]?.plannerCorrectionAdversary?.nestedPlanFields).toEqual([
      "requiredFiles.reason",
      "acceptanceCriteria",
      "implementationChecklist",
      "verificationChecklist",
      "verificationCommands"
    ]);
  });

  it("keeps every model-visible input generic while retaining isolated hidden verification", async () => {
    const manifest = await loadManifest();
    const sourceCases = await loadCases(manifest);
    const policy = manifest.protectedPathPolicy;

    expect(JSON.stringify(manifest.cases)).not.toMatch(/tests[\\/.]+(?:oracle|baseline)/i);
    for (const sourceCase of sourceCases) {
      expect(assessFeedbackContent(sourceCase.feedback.rawContent).accepted, sourceCase.id).toBe(true);
      expect(containsProtectedModelVisiblePath(sourceCase.feedback.rawContent, policy), sourceCase.id).toBe(false);
      expect(sourceCase.feedback.relevantFiles.every((path) => !containsProtectedModelVisiblePath(path, policy))).toBe(true);
      expect(sourceCase.expectedReferenceFiles.every((path) => !containsProtectedModelVisiblePath(path, policy))).toBe(true);
      expect(sourceCase.oracleTestPathPrefixes).toEqual(["tests/oracle/"]);
      expect(sourceCase.generatedTestPathPrefixes).toEqual(["tests/generated/"]);
      expect(sourceCase.runChangedPythonTests).toBe(true);

      const partitioned = partitionVerificationCommands(
        sourceCase.verificationCommands,
        [],
        sourceCase.oracleTestPathPrefixes
      );
      const modelVisibleVerification = sanitizeImplementationPlanForModel({
        requiredFiles: [],
        acceptanceCriteria: [],
        implementationChecklist: [],
        verificationChecklist: [],
        verificationCommands: partitioned.visible
      }, policy);
      expect(modelVisibleVerification.verificationCommands).toEqual([]);
      expect(JSON.stringify(modelVisibleVerification)).not.toMatch(/tests[\\/.]+(?:oracle|baseline)/i);
      expect(partitioned.oracles).toHaveLength(1);
    }

    for (const path of [
      "README.md",
      "index.html",
      "dashboard.js",
      "styles.css",
      "incident/api.py",
      "incident/repository.py",
      "incident/service.py",
      "tests/frontend_harness.py"
    ]) {
      const content = await readFile(join(manifest.frozenInputs.fixturePath, path), "utf8");
      expect(containsProtectedModelVisiblePath(content, policy), path).toBe(false);
    }

    expect(manifest.predeclaredSuccessCriteria).toHaveLength(10);
    expect(manifest.forbiddenRepairDiagnostics).toHaveLength(4);
    expect(manifest.integrityStopRules).toHaveLength(5);
    expect(manifest.requiredReporting).toHaveLength(6);
  });

  it("starts from one passing baseline and two independently sensitive hidden suites", async () => {
    const manifest = await loadManifest();

    expect(await unittestExitCode(manifest.frozenInputs.fixturePath, "tests.baseline.test_fixture_baseline")).toBe(0);
    expect(await unittestExitCode(manifest.frozenInputs.fixturePath, "tests.oracle.test_details_state")).not.toBe(0);
    expect(await unittestExitCode(manifest.frozenInputs.fixturePath, "tests.oracle.test_incident_summary")).not.toBe(0);
  });

  it("pins one override-free paid command with exactly two cases, one trial each, and one shared cap", async () => {
    const manifest = await loadManifest();
    const protocol = await readFile(protocolPath, "utf8");
    const command = protocol.match(
      /<!-- PAID_COMMAND_START -->([\s\S]*?)<!-- PAID_COMMAND_END -->/
    )?.[1];

    expect(command).toBeDefined();
    expect(command?.match(/^\s*--case\s+/gm)).toHaveLength(2);
    for (const caseId of manifest.run.caseIds) {
      expect(command).toContain(`--case ${caseId}`);
    }
    expect(command).toContain("env -u MOSAIC_LLM_PROVIDER");
    expect(command).toContain("-u MOSAIC_OPENAI_MODEL");
    expect(command).toContain("-u MOSAIC_OPENAI_REASONING_EFFORT");
    expect(command).toContain("--frozen-evaluation");
    expect(command).toContain("--generate");
    expect(command).toContain("--classify");
    expect(command).toContain("--provider openai");
    expect(command).toContain("--preset quality");
    expect(command).toContain("--trials 1");
    expect(command).toContain("--max-cost-usd 3");
    expect(command).toContain("MOSAIC_OPENAI_MIN_OUTPUT_TOKENS=49152");
    expect(command).toContain(`--pricing ${manifest.frozenInputs.pricingPath}`);
    expect(command).toContain(`--output-dir ${manifest.run.outputDir}`);
    expect(command).not.toMatch(/^\s*--model\s+/m);
    expect(command).not.toMatch(/^\s*--reasoning-effort\s+/m);
    expect(command).not.toMatch(/API_KEY=/);
  });
});

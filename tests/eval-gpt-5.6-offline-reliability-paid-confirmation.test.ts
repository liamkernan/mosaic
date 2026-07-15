import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { partitionVerificationCommands } from "../scripts/eval-local-fixes-support.js";

const manifestPath = "evals/gpt-5.6-offline-reliability-paid-confirmation-manifest-2026-07-15.json";
const protocolPath = "evals/GPT_5_6_OFFLINE_RELIABILITY_PAID_CONFIRMATION_PROTOCOL_2026_07_15.md";

interface SourceCase {
  id: string;
  fixturePath: string;
  feedback: {
    relevantFiles: string[];
  };
  expectedOpenAIRoute: {
    model: string;
    reasoningEffort: string;
  };
  oracleTestPathPrefixes: string[];
  generatedTestPathPrefixes: string[];
  verificationCommands: string[];
  runChangedPythonTests?: boolean;
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
    hiddenOraclePathPrefixes: string[];
    generatedTestPathPrefixes: string[];
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
    openAIMinTimeoutMs: number | null;
    caseTimeoutMs: number;
    maxCostUsd: number;
    outputDir: string;
  };
  prepaidLaunchIncidents: Array<{
    occurredAt: string;
    status: string;
    reason: string;
    reachedHarnessMain: boolean;
    outputDirCreated: boolean;
    caseTrialsStarted: number;
    requestAuthorizations: number;
    modelCalls: number;
    observedCostUsd: number;
    correctivePreflight: string;
  }>;
  cases: Array<{
    id: string;
    label: string;
    expectedAutomaticRoute: {
      model: string;
      reasoningEffort: string;
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

describe("frozen GPT-5.6 offline-reliability paid confirmation", () => {
  it("pins the retained cases, fixture, pricing, implementation, and transport minimum", async () => {
    const manifest = await loadManifest();

    expect(manifest).toEqual(expect.objectContaining({
      schemaVersion: 1,
      proofId: "gpt-5.6-offline-reliability-paid-confirmation-2026-07-15",
      proofKind: "non-holdout-three-case-confirmation",
      status: "predeclared-before-paid-execution"
    }));
    expect(manifest.implementationUnderTest).toEqual({
      commit: "87cdfb52b53ea2bd1883d8be63f0275e69fe3ab3",
      report: "evals/GPT_5_6_OFFLINE_RELIABILITY_IMPROVEMENTS_2026_07_14.md"
    });
    await expect(sha256File(manifest.frozenInputs.casesPath)).resolves.toBe(manifest.frozenInputs.casesSha256);
    await expect(sha256Path(manifest.frozenInputs.fixturePath)).resolves.toBe(manifest.frozenInputs.fixtureSha256);
    await expect(sha256File(manifest.frozenInputs.pricingPath)).resolves.toBe(manifest.frozenInputs.pricingSha256);
    expect(manifest.run).toEqual(expect.objectContaining({
      provider: "openai",
      preset: "quality",
      trialsPerCase: 1,
      caseCount: 3,
      modelOverride: null,
      reasoningEffortOverride: null,
      openAIMinOutputTokens: 49_152,
      openAIMinTimeoutMs: null,
      caseTimeoutMs: 900_000,
      maxCostUsd: 3
    }));
    expect(manifest.prepaidLaunchIncidents).toHaveLength(2);
    for (const incident of manifest.prepaidLaunchIncidents) {
      expect(incident).toEqual(expect.objectContaining({
        status: "invalidated-zero-call-launch",
        reachedHarnessMain: false,
        outputDirCreated: false,
        caseTrialsStarted: 0,
        requestAuthorizations: 0,
        modelCalls: 0,
        observedCostUsd: 0
      }));
    }
  });

  it("selects exactly the three retained cases and their production routes", async () => {
    const manifest = await loadManifest();
    const sourceCases = JSON.parse(
      await readFile(manifest.frozenInputs.casesPath, "utf8")
    ) as SourceCase[];
    const selected = sourceCases.filter((sourceCase) => manifest.run.caseIds.includes(sourceCase.id));

    expect(manifest.run.caseIds).toEqual([
      "post-routing-simple-watch-label",
      "post-routing-moderate-safe-details-state",
      "post-routing-complex-escalation-export"
    ]);
    expect(manifest.cases.map(({ id }) => id)).toEqual(manifest.run.caseIds);
    expect(selected.map(({ id }) => id)).toEqual(manifest.run.caseIds);
    expect(selected.map(({ expectedOpenAIRoute }) => expectedOpenAIRoute)).toEqual(
      manifest.cases.map(({ expectedAutomaticRoute }) => expectedAutomaticRoute)
    );
    expect(selected.map(({ expectedOpenAIRoute }) => expectedOpenAIRoute)).toEqual([
      { model: "gpt-5.6-terra", reasoningEffort: "high" },
      { model: "gpt-5.6-terra", reasoningEffort: "xhigh" },
      { model: "gpt-5.6-sol", reasoningEffort: "xhigh" }
    ]);
    for (const sourceCase of selected) {
      expect(sourceCase.fixturePath).toBe(manifest.frozenInputs.fixturePath);
      expect(sourceCase.model).toBeUndefined();
      expect(sourceCase.reasoningEffort).toBeUndefined();
    }
  });

  it("freezes visible criteria without leaking hidden verification into model-facing context", async () => {
    const manifest = await loadManifest();
    const sourceCases = JSON.parse(
      await readFile(manifest.frozenInputs.casesPath, "utf8")
    ) as SourceCase[];
    const selected = sourceCases.filter((sourceCase) => manifest.run.caseIds.includes(sourceCase.id));

    expect(manifest.cases.every(({ visibleAcceptanceCriteria }) => visibleAcceptanceCriteria.length >= 3)).toBe(true);
    expect(JSON.stringify(manifest.cases)).not.toMatch(/tests\/oracle|hidden oracle|oracle failure/i);
    expect(manifest.forbiddenRepairDiagnostics).toHaveLength(4);
    expect(manifest.predeclaredSuccessCriteria).toHaveLength(8);
    expect(manifest.integrityStopRules).toHaveLength(4);
    expect(manifest.requiredReporting).toHaveLength(4);

    for (const sourceCase of selected) {
      expect(sourceCase.oracleTestPathPrefixes).toEqual(manifest.frozenInputs.hiddenOraclePathPrefixes);
      expect(sourceCase.generatedTestPathPrefixes).toEqual(manifest.frozenInputs.generatedTestPathPrefixes);
      expect(sourceCase.feedback.relevantFiles.some((path) => path.startsWith("tests/oracle/"))).toBe(false);
      const partitioned = partitionVerificationCommands(
        sourceCase.verificationCommands,
        [],
        sourceCase.oracleTestPathPrefixes
      );
      expect(partitioned.visible.every((command) => !command.includes("tests.oracle")), sourceCase.id).toBe(true);
      expect(partitioned.oracles, sourceCase.id).toHaveLength(1);
    }
    expect(selected.filter(({ runChangedPythonTests }) => runChangedPythonTests)).toHaveLength(2);
  });

  it("pins one override-free paid command with exactly three cases and one shared cap", async () => {
    const manifest = await loadManifest();
    const protocol = await readFile(protocolPath, "utf8");
    const command = protocol.match(
      /<!-- PAID_COMMAND_START -->([\s\S]*?)<!-- PAID_COMMAND_END -->/
    )?.[1];

    expect(command).toBeDefined();
    expect(protocol).toContain("pnpm build");
    expect(protocol).toContain("invalidated-zero-call-launch");
    expect(command).toContain("env -u MOSAIC_LLM_PROVIDER");
    expect(command?.match(/^\s*--case\s+/gm)).toHaveLength(3);
    for (const caseId of manifest.run.caseIds) {
      expect(command).toContain(`--case ${caseId}`);
    }
    expect(command).toContain("--generate");
    expect(command).toContain("--classify");
    expect(command).toContain("--frozen-evaluation");
    expect(command).toContain("--provider openai");
    expect(command).toContain("--preset quality");
    expect(command).toContain("--trials 1");
    expect(command).toContain("--max-cost-usd 3");
    expect(command).toContain(`--pricing ${manifest.frozenInputs.pricingPath}`);
    expect(command).toContain(`--output-dir ${manifest.run.outputDir}`);
    expect(command).toContain("MOSAIC_OPENAI_MIN_OUTPUT_TOKENS=49152");
    expect(command).toMatch(/MOSAIC_OPENAI_MODEL= \\\n/);
    expect(command).toMatch(/MOSAIC_OPENAI_REASONING_EFFORT= \\\n/);
    expect(command).not.toMatch(/^\s*--model\s+/m);
    expect(command).not.toMatch(/^\s*--reasoning-effort\s+/m);
    expect(command).not.toMatch(/API_KEY=/);
  });
});

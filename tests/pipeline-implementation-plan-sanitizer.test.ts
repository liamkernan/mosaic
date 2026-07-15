import { describe, expect, it } from "vitest";

import {
  containsProtectedModelVisiblePath,
  sanitizeImplementationPlanForModel,
  sanitizeModelVisiblePlanText
} from "../packages/pipeline/src/implementation-plan-sanitizer.js";

const policy = {
  protectedPaths: ["fixtures/hidden/expected.json"],
  protectedPathPrefixes: ["tests/oracle/", "tests/baseline/"],
  generatedTestPathPrefixes: ["tests/generated/"]
};

const protectedReferencePattern = /tests(?:[\\/.]+)(?:oracle|baseline)|fixtures(?:[\\/.]+)hidden(?:[\\/.]+)expected/i;

describe("implementation-plan model-visible sanitization", () => {
  it("scrubs the exact checklist shape retained by the invalidated confirmation", () => {
    expect(sanitizeModelVisiblePlanText(
      "Do not modify tests/baseline/ or tests/oracle/.",
      policy
    )).toBe("Do not modify immutable verification tests.");
  });

  it("drops protected executable commands but retains a generic verification boundary", () => {
    const sanitized = sanitizeImplementationPlanForModel({
      requiredFiles: [{ path: "src/service.py", reason: "Fix the behavior." }],
      acceptanceCriteria: ["The visible behavior works."],
      implementationChecklist: ["Update the service."],
      verificationChecklist: ["Run public checks."],
      verificationCommands: ["python3 -m unittest TESTS.ORACLE.Test_Secret"]
    }, policy);

    expect(sanitized.verificationCommands).toEqual([]);
    expect(sanitized.verificationChecklist).toEqual([
      "Run public checks.",
      "Verify behavior with immutable verification tests outside model-visible implementation and repair."
    ]);
  });

  it("fails closed when an unapproved test has no generated-test destination", () => {
    const sanitized = sanitizeImplementationPlanForModel({
      requiredFiles: [
        { path: "src/service.py", reason: "Fix behavior without tests/private/test_secret.py." },
        { path: "tests/private/test_secret.py", reason: "Change the protected regression." }
      ],
      acceptanceCriteria: ["Do not depend on tests.private.test_secret."],
      implementationChecklist: ["Leave tests\\private\\test_secret.py unchanged."],
      verificationChecklist: ["Run public checks."],
      verificationCommands: ["python3 -m unittest tests.private.test_secret"]
    }, {
      protectedPaths: [],
      protectedPathPrefixes: [],
      generatedTestPathPrefixes: []
    });

    expect(sanitized.requiredFiles).toEqual([{
      path: "src/service.py",
      reason: "Fix behavior without immutable verification tests."
    }]);
    expect(JSON.stringify(sanitized)).not.toMatch(/tests(?:[\\/.]+)private/i);
    expect(sanitized.verificationCommands).toEqual([]);
  });

  it("scrubs protected variants from every plan field while retaining useful generic intent", () => {
    const sanitized = sanitizeImplementationPlanForModel({
      summary: "Keep Tests\\Oracle\\Test_Secret.py and TESTS.BASELINE.test_fixture immutable.",
      requiredFiles: [
        { path: "src/service.py", reason: "Implement behavior without reading tests.oracle.test_secret." },
        { path: "Tests\\Oracle\\Test_Secret.py", reason: "Extend the hidden assertion." },
        { path: "tests/unit/test_service.py", reason: "Add a focused public regression." }
      ],
      acceptanceCriteria: [
        "The public behavior passes without consulting tests/oracle/ or fixtures/hidden/expected.json.",
        "Preserve the existing Oracle database adapter."
      ],
      implementationChecklist: [
        "Do not modify TESTS\\BASELINE\\ or Tests.Oracle.Test_Secret.",
        "Add tests\\unit\\test_service.py for the visible contract."
      ],
      verificationChecklist: [
        "Run tests.oracle.test_secret only outside model-visible work.",
        "Run the new tests.unit.test_service regression independently."
      ],
      verificationCommands: [
        "python3 -m unittest tests.oracle.test_secret",
        "python3 -m unittest TESTS.BASELINE.test_fixture",
        "python3 -m unittest tests.unit.test_service"
      ],
      metadata: {
        summary: "Never reveal Fixtures\\Hidden\\Expected.json."
      }
    }, policy);

    expect(JSON.stringify(sanitized)).not.toMatch(protectedReferencePattern);
    expect(sanitized.summary).toContain("immutable verification tests");
    expect(sanitized.metadata.summary).toContain("immutable verification tests");
    expect(sanitized.acceptanceCriteria).toContain("Preserve the existing Oracle database adapter.");
    expect(sanitized.requiredFiles).toEqual([
      {
        path: "src/service.py",
        reason: "Implement behavior without reading immutable verification tests."
      },
      {
        path: "tests/generated/test_generated_regression.py",
        reason: "Add independent generated regression coverage; immutable verification tests remain separate"
      },
      {
        path: "tests/generated/test_service.py",
        reason: "Add a focused public regression."
      }
    ]);
    expect(sanitized.implementationChecklist).toContain(
      "Add tests/generated/test_service.py for the visible contract."
    );
    expect(sanitized.verificationCommands).toEqual([
      "python3 -m unittest tests.generated.test_service"
    ]);
  });

  it("keeps generated paths, ordinary source paths, and non-path oracle wording unchanged", () => {
    const plan = {
      summary: "Use the Oracle database adapter and keep unit tests focused.",
      requiredFiles: [
        { path: "src/oracle-client.ts", reason: "Update the Oracle database client." },
        { path: "tests/generated/test_safe.py", reason: "Add generated regression coverage." }
      ],
      acceptanceCriteria: ["The source behavior and unit tests pass."],
      implementationChecklist: ["Update src/oracle-client.ts."],
      verificationChecklist: ["Run the generated regression."],
      verificationCommands: ["python3 -m unittest tests.generated.test_safe"]
    };

    expect(sanitizeImplementationPlanForModel(plan, policy)).toEqual(plan);
    expect(sanitizeModelVisiblePlanText("An oracle explains expected behavior; tests remain useful.", policy))
      .toBe("An oracle explains expected behavior; tests remain useful.");
    expect(sanitizeModelVisiblePlanText("Keep tests/oracle-helper/ and tests/baseline_data/ unchanged.", policy))
      .toBe("Keep tests/oracle-helper/ and tests/baseline_data/ unchanged.");
    expect(sanitizeModelVisiblePlanText("Keep fixtures/hidden/expected.schema.json unchanged.", policy))
      .toBe("Keep fixtures/hidden/expected.schema.json unchanged.");
  });

  it.each([
    "tests/oracle/test_secret.py",
    "TESTS\\ORACLE\\TEST_SECRET.PY",
    "tests.oracle.test_secret",
    "Fixtures/Hidden/Expected.json"
  ])("detects the canonical protected request variant %s", (value) => {
    expect(containsProtectedModelVisiblePath(value, policy)).toBe(true);
  });

  it.each([
    "immutable verification tests",
    "The oracle explains expected behavior.",
    "tests/oracle-helper/test_public.py",
    "tests/baseline_data/test_public.py",
    "fixtures/hidden/expected.schema.json"
  ])("allows generic or near-miss request wording %s", (value) => {
    expect(containsProtectedModelVisiblePath(value, policy)).toBe(false);
  });
});

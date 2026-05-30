import { describe, expect, it } from "vitest";

import { validatePlanCompletion } from "../packages/pipeline/src/plan-completion-validator.js";

const basePlan = {
  requiredFiles: [],
  acceptanceCriteria: [],
  implementationChecklist: [],
  verificationChecklist: [],
  verificationCommands: []
};

describe("validatePlanCompletion", () => {
  it("rejects substituted ordered tie-breakers from acceptance criteria", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "mosaic_demo/service.py",
          originalContent: "order_by = \"sr.created_at ASC\"\n",
          modifiedContent: "order_by = \"sr.sla_due_at ASC, sr.id ASC\"\n",
          explanation: "sort by SLA due date"
        },
        {
          filePath: "tests/reported/test_001_sla_sort.py",
          originalContent: "def test_sla(): pass\n",
          modifiedContent: "def test_sla(): assert True\n",
          explanation: "update reported test"
        }
      ],
      {
        ...basePlan,
        acceptanceCriteria: ["`list_requests(..., sort=\"sla\")` should order by `sla_due_at ASC`, then `created_at ASC`."],
        verificationChecklist: ["Add a unittest covering the SLA tie-breaker."]
      }
    );

    expect(errors.join("\n")).toContain("sla_due_at ASC, created_at ASC");
  });

  it("accepts required ordered terms with an extra tertiary tie-breaker", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "mosaic_demo/service.py",
          originalContent: "order_by = \"sr.created_at ASC\"\n",
          modifiedContent: "order_by = \"sr.sla_due_at ASC, sr.created_at ASC, sr.id ASC\"\n",
          explanation: "sort by SLA due date"
        },
        {
          filePath: "tests/reported/test_001_sla_sort.py",
          originalContent: "def test_sla(): pass\n",
          modifiedContent: "def test_sla_tie_breaker(): assert True\n",
          explanation: "cover tie-breaker"
        }
      ],
      {
        ...basePlan,
        acceptanceCriteria: ["Requests should order by `sla_due_at ASC`, then `created_at ASC`."],
        verificationChecklist: ["Add a unittest covering the SLA tie-breaker."]
      }
    );

    expect(errors).toEqual([]);
  });

  it("requires test changes when the plan asks for behavioral sort coverage", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "src/service.ts",
          originalContent: "return items;\n",
          modifiedContent: "return items.sort();\n",
          explanation: "sort queue"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [{ path: "tests/service.test.ts", reason: "coverage for queue sort" }],
        acceptanceCriteria: ["Queue sort orders urgent items first."],
        verificationChecklist: ["Add a test for queue sorting."]
      }
    );

    expect(errors.join("\n")).toContain("does not modify any test/spec file");
  });
});

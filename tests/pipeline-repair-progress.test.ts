import { describe, expect, it } from "vitest";

import { assessRepairProgress } from "../packages/pipeline/src/repair-progress.js";

const existingChange = {
  filePath: "src/service.ts",
  originalContent: "export const value = 1;\n",
  modifiedContent: "export const value = 2;\n",
  explanation: "Update behavior."
};

describe("repair progress", () => {
  it("accepts a repair that reduces the error set without growing scope", () => {
    expect(assessRepairProgress(
      [existingChange],
      [{ ...existingChange, modifiedContent: "export const value = 3;\n" }],
      [
        "Syntax validation failed for src/service.ts: invalid token",
        "Change for src/service.ts adds modal UI hooks without complete open/close/keyboard behavior"
      ],
      ["Syntax validation failed for src/service.ts: invalid token"]
    )).toEqual({
      accepted: true,
      trend: "reduced",
      addedFiles: [],
      unplannedAddedFiles: [],
      introducedCategories: []
    });
  });

  it("accepts a planned new file when it reduces errors without adding a category", () => {
    expect(assessRepairProgress(
      [existingChange],
      [
        existingChange,
        {
          filePath: "styles.css",
          originalContent: "",
          modifiedContent: ".product { display: grid; }\n",
          explanation: "Add the planned presentation layer."
        }
      ],
      [
        "Matching selectors in changed stylesheets are required",
        "Frontend assertion failed: expected element not found"
      ],
      ["Frontend assertion failed: expected element not found"],
      { plannedFiles: ["index.html", "script.js", "styles.css"] }
    )).toEqual({
      accepted: true,
      trend: "reduced",
      addedFiles: ["styles.css"],
      unplannedAddedFiles: [],
      introducedCategories: []
    });
  });

  it("rejects an outside-plan file even when it reduces errors", () => {
    expect(assessRepairProgress(
      [existingChange],
      [
        existingChange,
        {
          filePath: "src/unplanned.ts",
          originalContent: "",
          modifiedContent: "export const unrelated = true;\n",
          explanation: "Expand scope."
        }
      ],
      ["Syntax validation failed for src/service.ts: invalid token"],
      [],
      { plannedFiles: ["src/service.ts"] }
    )).toEqual(expect.objectContaining({
      accepted: false,
      trend: "increased",
      addedFiles: ["src/unplanned.ts"],
      unplannedAddedFiles: ["src/unplanned.ts"]
    }));
  });

  it("rejects a planned new file when it does not reduce errors", () => {
    const plannedChange = {
      filePath: "styles.css",
      originalContent: "",
      modifiedContent: ".product { display: grid; }\n",
      explanation: "Add the planned presentation layer."
    };

    expect(assessRepairProgress(
      [existingChange],
      [existingChange, plannedChange],
      ["Frontend assertion failed: expected element not found"],
      ["Frontend assertion failed: expected element not found"],
      { plannedFiles: ["styles.css"] }
    )).toEqual(expect.objectContaining({
      accepted: false,
      trend: "increased",
      addedFiles: ["styles.css"],
      unplannedAddedFiles: []
    }));
  });

  it("rejects a repair that introduces a new error category", () => {
    expect(assessRepairProgress(
      [existingChange],
      [{ ...existingChange, modifiedContent: "<div class=\"clickable\"></div>" }],
      ["Syntax validation failed for src/service.ts: invalid token"],
      ["Change for src/service.ts makes non-interactive container(s) appear clickable; use native button/link elements"]
    )).toEqual(expect.objectContaining({
      accepted: false,
      trend: "increased",
      addedFiles: [],
      introducedCategories: ["accessibility"]
    }));
  });

  it("rejects a repair that increases errors in an existing category", () => {
    expect(assessRepairProgress(
      [existingChange],
      [{ ...existingChange, modifiedContent: "broken" }],
      ["Syntax validation failed for src/service.ts: first"],
      [
        "Syntax validation failed for src/service.ts: first",
        "Syntax validation failed for src/service.ts: second"
      ]
    )).toEqual(expect.objectContaining({
      accepted: false,
      trend: "increased"
    }));
  });

  it("rejects a changed candidate when revalidation returns the exact same errors", () => {
    expect(assessRepairProgress(
      [existingChange],
      [{ ...existingChange, modifiedContent: "export const value = 3;\n" }],
      [
        "Implementation plan requires runtime/source changes for backing server behavior",
        "Implementation plan requires runtime/source changes for a full-stack UI request"
      ],
      [
        "Implementation plan requires runtime/source changes for a full-stack UI request",
        "Implementation plan requires runtime/source changes for backing server behavior"
      ]
    )).toEqual(expect.objectContaining({
      accepted: false,
      trend: "stalled"
    }));
  });

  it("keeps independent generated-test failures in the verification category", () => {
    expect(assessRepairProgress(
      [existingChange],
      [{ ...existingChange, modifiedContent: "export const value = 3;\n" }],
      ["Verification command failed: test_panel.py"],
      ["Generated test failed independently (tests/generated/test_panel.py): missing #saveFilterButton"]
    )).toEqual(expect.objectContaining({
      accepted: true,
      introducedCategories: []
    }));
  });
});

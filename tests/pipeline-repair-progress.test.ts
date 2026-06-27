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
      introducedCategories: []
    });
  });

  it("rejects a repair that introduces a new file", () => {
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
      []
    )).toEqual(expect.objectContaining({
      accepted: false,
      trend: "increased",
      addedFiles: ["src/unplanned.ts"]
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
});

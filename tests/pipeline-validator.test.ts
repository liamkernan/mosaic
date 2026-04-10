import { describe, expect, it } from "vitest";

import { validate } from "../packages/pipeline/src/validator.js";

describe("validate", () => {
  it("rejects unsafe additions", async () => {
    const result = await validate(
      [
        {
          filePath: "src/index.ts",
          originalContent: "export const safeValue = 1;\n",
          modifiedContent: "export const safeValue = 1;\nconst run = eval('1');\n",
          explanation: "unsafe"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath: process.cwd(),
        fileTree: [],
        installationId: 1
      }
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("Unsafe patterns");
  });

  it("accepts small safe changes", async () => {
    const result = await validate(
      [
        {
          filePath: "README.md",
          originalContent: "Old title\n",
          modifiedContent: "New title\n",
          explanation: "copy change"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath: process.cwd(),
        fileTree: [],
        installationId: 1
      }
    );

    expect(result.valid).toBe(true);
  });
});

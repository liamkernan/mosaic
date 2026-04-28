import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { validate } from "../packages/pipeline/src/validator.js";

describe("validate", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

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

  it("rejects modal UI changes that do not add matching styles", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await writeFile(join(localPath, "index.html"), "<div>before</div>\n", "utf8");
    await writeFile(join(localPath, "styles.css"), ".collection-card { padding: 1rem; }\n", "utf8");

    const result = await validate(
      [
        {
          filePath: "index.html",
          originalContent: "<div>before</div>\n",
          modifiedContent:
            '<div class="collection-modal-overlay"><div class="collection-modal"></div></div>\n',
          explanation: "add modal"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [
          { path: "index.html", type: "file" },
          { path: "styles.css", type: "file" }
        ],
        installationId: 1
      }
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("does not update styles.css");
  });
});

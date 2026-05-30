import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { GeneratedChange, RepoContext } from "../packages/core/src/types.js";
import { applyValidationFallbacks } from "../packages/pipeline/src/validation-repair.js";

describe("applyValidationFallbacks", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("adds minimal stylesheet coverage for modal hooks reported by validation", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validation-repair-"));
    tempDirs.push(localPath);
    await writeFile(join(localPath, "styles.css"), ".collection-card { padding: 1rem; }\n", "utf8");

    const repoContext: RepoContext = {
      fullName: "owner/repo",
      defaultBranch: "main",
      localPath,
      installationId: 1,
      fileTree: [
        { path: "index.html", type: "file" },
        { path: "styles.css", type: "file" }
      ]
    };
    const changes: GeneratedChange[] = [
      {
        filePath: "index.html",
        originalContent: "<main></main>\n",
        modifiedContent: '<main><div class="collection-modal-overlay"><div class="collection-modal"></div></div></main>\n',
        explanation: "add collection modal"
      }
    ];

    const completed = await applyValidationFallbacks(changes, repoContext, [
      "Change for index.html adds modal UI hooks (collection-modal-overlay, collection-modal) but does not update styles.css with matching styles"
    ]);

    expect(completed).toHaveLength(2);
    const styleChange = completed.find((change) => change.filePath === "styles.css");
    expect(styleChange?.modifiedContent).toContain(".collection-modal-overlay");
    expect(styleChange?.modifiedContent).toContain(".collection-modal");
  });

  it("returns the original change set when no fallback applies", async () => {
    const repoContext: RepoContext = {
      fullName: "owner/repo",
      defaultBranch: "main",
      localPath: process.cwd(),
      installationId: 1,
      fileTree: []
    };
    const changes: GeneratedChange[] = [
      {
        filePath: "README.md",
        originalContent: "old\n",
        modifiedContent: "new\n",
        explanation: "update docs"
      }
    ];

    await expect(applyValidationFallbacks(changes, repoContext, ["Total new code added exceeds limit: 300 lines"])).resolves.toBe(changes);
  });
});

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

  it("links new static assets from html when validation reports they are orphaned", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validation-repair-"));
    tempDirs.push(localPath);
    await writeFile(join(localPath, "index.html"), "<!doctype html><html><head></head><body><main></main></body></html>\n", "utf8");

    const repoContext: RepoContext = {
      fullName: "owner/repo",
      defaultBranch: "main",
      localPath,
      installationId: 1,
      fileTree: [{ path: "index.html", type: "file" }]
    };
    const changes: GeneratedChange[] = [
      {
        filePath: "collection-modal.js",
        originalContent: "",
        modifiedContent: "document.body.dataset.ready = 'true';\n",
        explanation: "add collection modal behavior"
      },
      {
        filePath: "collection-modal.css",
        originalContent: "",
        modifiedContent: ".collection-modal { display: block; }\n",
        explanation: "add collection modal styles"
      }
    ];

    const completed = await applyValidationFallbacks(changes, repoContext, [
      "New static asset collection-modal.js is not linked from index.html",
      "New static asset collection-modal.css is not linked from index.html"
    ]);

    const htmlChange = completed.find((change) => change.filePath === "index.html");
    expect(htmlChange?.modifiedContent).toContain('<link rel="stylesheet" href="./collection-modal.css" />');
    expect(htmlChange?.modifiedContent).toContain('<script src="./collection-modal.js"></script>');
  });

  it("adds missing html hooks for modal scripts when validation reports unmatched selectors", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validation-repair-"));
    tempDirs.push(localPath);
    await writeFile(
      join(localPath, "index.html"),
      '<!doctype html><html><body><main><article class="collection-card"><h3>Kitchen</h3></article></main></body></html>\n',
      "utf8"
    );

    const repoContext: RepoContext = {
      fullName: "owner/repo",
      defaultBranch: "main",
      localPath,
      installationId: 1,
      fileTree: [{ path: "index.html", type: "file" }]
    };
    const changes: GeneratedChange[] = [
      {
        filePath: "script.js",
        originalContent: "console.log('ready');\n",
        modifiedContent:
          "document.getElementById('modalOverlay').classList.add('is-open');\ndocument.getElementById('modalTitle').textContent = 'Kitchen';\ndocument.querySelectorAll('.collection-card[data-collection]');\ndocument.querySelector('.modal-close');\n",
        explanation: "wire collection modal"
      }
    ];

    const completed = await applyValidationFallbacks(changes, repoContext, [
      "Change for script.js queries missing HTML id(s): modalOverlay, modalTitle",
      "Change for script.js queries selector(s) with no matching HTML: .collection-card[data-collection], .modal-close"
    ]);

    const htmlChange = completed.find((change) => change.filePath === "index.html");
    expect(htmlChange?.modifiedContent).toContain('class="collection-card" data-collection="kitchen"');
    expect(htmlChange?.modifiedContent).toContain('id="modalOverlay"');
    expect(htmlChange?.modifiedContent).toContain('id="modalTitle"');
    expect(htmlChange?.modifiedContent).toContain('class="modal-close"');
  });
});

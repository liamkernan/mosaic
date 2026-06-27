import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RepoIndexer } from "../packages/pipeline/src/repo-indexer.js";

describe("RepoIndexer repository references", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("flattens repository file trees in pre-order without exposing the cached array", () => {
    const indexer = new RepoIndexer();
    const context = {
      fullName: "owner/repo",
      defaultBranch: "main",
      localPath: process.cwd(),
      installationId: 1,
      fileTree: [
        {
          path: "src",
          type: "directory" as const,
          children: [
            { path: "src/index.ts", type: "file" as const },
            {
              path: "src/components",
              type: "directory" as const,
              children: [{ path: "src/components/card.ts", type: "file" as const }]
            }
          ]
        },
        { path: "README.md", type: "file" as const }
      ]
    };

    const first = indexer.fileTreeToPaths(context);
    first.push("mutated-by-caller");

    expect(first).toEqual([
      "src",
      "src/index.ts",
      "src/components",
      "src/components/card.ts",
      "README.md",
      "mutated-by-caller"
    ]);
    expect(indexer.fileTreeToPaths(context)).toEqual([
      "src",
      "src/index.ts",
      "src/components",
      "src/components/card.ts",
      "README.md"
    ]);
  });

  it("loads promoted local issue specs and related reported tests as authoritative references", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-repo-indexer-"));
    tempDirs.push(localPath);
    await mkdir(join(localPath, "issues"));
    await mkdir(join(localPath, "tests", "reported"), { recursive: true });
    await mkdir(join(localPath, "src"));
    await writeFile(join(localPath, "README.md"), "# Demo\n", "utf8");
    await writeFile(
      join(localPath, "issues", "001-sla-queue-ordering.md"),
      "Expected: order by `sla_due_at ASC`, then `created_at ASC`.\n",
      "utf8"
    );
    await writeFile(join(localPath, "tests", "reported", "test_001_sla_sort.py"), "def test_sla_sort(): pass\n", "utf8");
    await writeFile(join(localPath, "src", "service.py"), "def list_requests(): pass\n", "utf8");

    const references = await new RepoIndexer().findRepositoryReferenceFiles(
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        installationId: 1,
        fileTree: [
          { path: "README.md", type: "file" },
          {
            path: "issues",
            type: "directory",
            children: [{ path: "issues/001-sla-queue-ordering.md", type: "file", language: "markdown" }]
          },
          {
            path: "tests",
            type: "directory",
            children: [
              {
                path: "tests/reported",
                type: "directory",
                children: [{ path: "tests/reported/test_001_sla_sort.py", type: "file", language: "python" }]
              }
            ]
          },
          {
            path: "src",
            type: "directory",
            children: [{ path: "src/service.py", type: "file", language: "python" }]
          }
        ]
      },
      {
        id: "01TEST",
        source: "web_form",
        rawContent: "The support queue should show the next SLA breach first when sort=sla.",
        senderIdentifier: "user@example.com",
        repoFullName: "owner/repo",
        receivedAt: new Date(),
        metadata: {},
        category: "bug_report",
        complexity: "moderate",
        summary: "Fix SLA queue ordering",
        relevantFiles: ["src/service.py"],
        confidence: 0.3
      },
      { issueNumber: 1 }
    );

    expect(references.map((file) => file.path)).toContain("issues/001-sla-queue-ordering.md");
    expect(references.map((file) => file.path)).toContain("tests/reported/test_001_sla_sort.py");
    expect(references.find((file) => file.path === "issues/001-sla-queue-ordering.md")?.reason).toContain("issue #1");
  });

  it("does not load sibling issue specs or reported tests for a promoted issue", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-repo-indexer-"));
    tempDirs.push(localPath);
    await mkdir(join(localPath, "issues"));
    await mkdir(join(localPath, "tests", "reported"), { recursive: true });
    const files = [
      ["issues/001-sla-sort.md", "Sort by SLA deadline.\n"],
      ["issues/002-deadline-idempotency.md", "Unrelated deadline intake behavior.\n"],
      ["tests/reported/test_001_sla_sort.py", "def test_sla_sort(): pass\n"],
      ["tests/reported/test_002_deadline_idempotency.py", "def test_deadline_idempotency(): pass\n"]
    ] as const;
    for (const [path, content] of files) {
      await writeFile(join(localPath, path), content, "utf8");
    }

    const references = await new RepoIndexer().findRepositoryReferenceFiles(
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        installationId: 1,
        fileTree: [
          {
            path: "issues",
            type: "directory",
            children: files.slice(0, 2).map(([path]) => ({ path, type: "file" as const, language: "markdown" }))
          },
          {
            path: "tests/reported",
            type: "directory",
            children: files.slice(2).map(([path]) => ({ path, type: "file" as const, language: "python" }))
          }
        ]
      },
      {
        id: "01TEST",
        source: "web_form",
        rawContent: "The SLA sort must order the next deadline first.",
        senderIdentifier: "user@example.com",
        repoFullName: "owner/repo",
        receivedAt: new Date(),
        metadata: {},
        category: "bug_report",
        complexity: "moderate",
        summary: "Fix SLA sort order",
        relevantFiles: [],
        confidence: 0.8
      },
      { issueNumber: 1 }
    );

    expect(references.map((file) => file.path)).toEqual([
      "issues/001-sla-sort.md",
      "tests/reported/test_001_sla_sort.py"
    ]);
  });

  it("keeps exact promoted issue references without requiring content term matches", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-repo-indexer-"));
    tempDirs.push(localPath);
    await mkdir(join(localPath, "issues"));
    await writeFile(
      join(localPath, "issues", "042-payment-reconciliation.md"),
      "Acceptance criteria are intentionally phrased differently from the feedback text.\n",
      "utf8"
    );

    const references = await new RepoIndexer().findRepositoryReferenceFiles(
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        installationId: 1,
        fileTree: [
          {
            path: "issues",
            type: "directory",
            children: [{ path: "issues/042-payment-reconciliation.md", type: "file", language: "markdown" }]
          }
        ]
      },
      {
        id: "01TEST",
        source: "web_form",
        rawContent: "Fix customer billing totals",
        senderIdentifier: "user@example.com",
        repoFullName: "owner/repo",
        receivedAt: new Date(),
        metadata: {},
        category: "bug_report",
        complexity: "moderate",
        summary: "Fix customer billing totals",
        relevantFiles: [],
        confidence: 0.3
      },
      { issueNumber: 42 }
    );

    expect(references.map((file) => file.path)).toEqual(["issues/042-payment-reconciliation.md"]);
    expect(references[0]?.reason).toContain("issue #42");
  });

  it("excludes generic nested READMEs while retaining path-relevant package documentation", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-repo-indexer-"));
    tempDirs.push(localPath);
    await mkdir(join(localPath, "docs", "react"), { recursive: true });
    await mkdir(join(localPath, "code", "addons", "vitest"), { recursive: true });
    await writeFile(join(localPath, "README.md"), "# Storybook\n", "utf8");
    await writeFile(join(localPath, "docs", "react", "README.md"), "# Storybook React documentation\n", "utf8");
    await writeFile(
      join(localPath, "docs", "react", "Files.tsx"),
      "export const note = 'browser context';\n",
      "utf8"
    );
    await writeFile(
      join(localPath, "code", "addons", "vitest", "README.md"),
      "# Vitest addon browser context\n",
      "utf8"
    );

    const references = await new RepoIndexer().findRepositoryReferenceFiles(
      {
        fullName: "storybookjs/storybook",
        defaultBranch: "main",
        localPath,
        installationId: 1,
        fileTree: [
          { path: "README.md", type: "file", language: "markdown" },
          { path: "docs/react/README.md", type: "file", language: "markdown" },
          { path: "docs/react/Files.tsx", type: "file", language: "typescript" },
          { path: "code/addons/vitest/README.md", type: "file", language: "markdown" }
        ]
      },
      {
        id: "01TEST",
        source: "web_form",
        rawContent: "The Storybook Vitest addon imports browser context outside browser mode.",
        senderIdentifier: "user@example.com",
        repoFullName: "storybookjs/storybook",
        receivedAt: new Date(),
        metadata: {},
        category: "bug_report",
        complexity: "moderate",
        summary: "Fix Storybook Vitest browser context loading",
        relevantFiles: ["code/addons/vitest/src/test-utils.ts"],
        confidence: 0.8
      },
      { issueNumber: 32444 }
    );

    expect(references.map((file) => file.path)).toEqual([
      "code/addons/vitest/README.md",
      "README.md"
    ]);
  });

  it("does not read classifier or requested files outside the repository root", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-repo-indexer-"));
    const outsidePath = await mkdtemp(join(tmpdir(), "mosaic-repo-outside-"));
    tempDirs.push(localPath, outsidePath);
    await mkdir(join(localPath, "src"));
    await writeFile(join(localPath, "src", "service.ts"), "export const safe = true;\n", "utf8");
    await writeFile(join(outsidePath, "secret.txt"), "host secret\n", "utf8");
    await symlink(join(outsidePath, "secret.txt"), join(localPath, "src", "secret-link.txt"));

    const context = {
      fullName: "owner/repo",
      defaultBranch: "main",
      localPath,
      installationId: 1,
      fileTree: [{ path: "src/service.ts", type: "file" as const }]
    };
    const indexer = new RepoIndexer();

    const relevantFiles = await indexer.findRelevantFiles(context, {
      id: "01TEST",
      source: "web_form",
      rawContent: "Please inspect the files",
      senderIdentifier: "user@example.com",
      repoFullName: "owner/repo",
      receivedAt: new Date(),
      metadata: {},
      category: "bug_report",
      complexity: "simple",
      summary: "Inspect files",
      relevantFiles: ["src/service.ts", "../secret.txt", "src/secret-link.txt"],
      confidence: 0.9
    });

    expect(relevantFiles.map((file) => file.path)).toEqual(["src/service.ts"]);
    expect(relevantFiles[0]?.content).toContain("safe = true");

    const requestedFiles = await indexer.readFiles(context, [
      { path: "src/service.ts", reason: "safe" },
      { path: "../secret.txt", reason: "traversal" },
      { path: "src/secret-link.txt", reason: "symlink" }
    ]);

    expect(requestedFiles.map((file) => file.path)).toEqual(["src/service.ts"]);
  });

  it("preserves first-200-line truncation for large files", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-repo-indexer-"));
    tempDirs.push(localPath);
    await mkdir(join(localPath, "src"));

    const line = `export const fixture = "${"x".repeat(600)}";\n`;
    const content = line.repeat(250);
    await writeFile(join(localPath, "src", "large.ts"), content, "utf8");

    const files = await new RepoIndexer().readFiles(
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        installationId: 1,
        fileTree: [
          {
            path: "src",
            type: "directory",
            children: [{ path: "src/large.ts", type: "file", language: "typescript", sizeBytes: Buffer.byteLength(content) }]
          }
        ]
      },
      [{ path: "src/large.ts", reason: "large file" }]
    );

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("src/large.ts");
    expect(files[0]?.reason).toBe("large file");
    expect(files[0]?.content).toBe(content.split("\n").slice(0, 200).join("\n"));
  });

  it("truncates large files when the file tree has no eager size metadata", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-repo-indexer-"));
    tempDirs.push(localPath);
    await mkdir(join(localPath, "src"));

    const line = `export const lazyFixture = "${"x".repeat(600)}";\n`;
    const content = line.repeat(250);
    await writeFile(join(localPath, "src", "lazy-large.ts"), content, "utf8");

    const files = await new RepoIndexer().readFiles(
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        installationId: 1,
        fileTree: [
          {
            path: "src",
            type: "directory",
            children: [{ path: "src/lazy-large.ts", type: "file", language: "typescript" }]
          }
        ]
      },
      [{ path: "src/lazy-large.ts", reason: "large file without cached size" }]
    );

    expect(files).toHaveLength(1);
    expect(files[0]?.content).toBe(content.split("\n").slice(0, 200).join("\n"));
  });
});

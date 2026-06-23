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

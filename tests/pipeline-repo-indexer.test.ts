import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RepoIndexer } from "../packages/pipeline/src/repo-indexer.js";

describe("RepoIndexer repository references", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
});

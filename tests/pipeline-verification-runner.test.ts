import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runVerificationCommands } from "../packages/pipeline/src/verification-runner.js";

describe("runVerificationCommands", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createPythonRepo(): Promise<string> {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-verify-test-"));
    tempDirs.push(localPath);
    await mkdir(join(localPath, "tests", "reported"), { recursive: true });
    await writeFile(join(localPath, "tests", "reported", "test_example.py"), "import unittest\n\nclass ExampleTest(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(1, 1)\n", "utf8");
    return localPath;
  }

  async function createStaticSiteRepo(script = "document.querySelector('#target').textContent = 'ready';\n"): Promise<string> {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-verify-site-"));
    tempDirs.push(localPath);
    await writeFile(localPath + "/index.html", "<!doctype html><html><body><div id=\"target\"></div><script src=\"script.js\"></script></body></html>\n", "utf8");
    await writeFile(localPath + "/script.js", script, "utf8");
    return localPath;
  }

  it("runs allowlisted verification commands in a temp copy", async () => {
    const localPath = await createPythonRepo();

    const result = await runVerificationCommands(
      [],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [],
        installationId: 1
      },
      {
        requiredFiles: [],
        acceptanceCriteria: [],
        implementationChecklist: [],
        verificationChecklist: [],
        verificationCommands: ["python3 -m unittest tests.reported.test_example"]
      }
    );

    expect(result.valid).toBe(true);
    expect(result.commands).toEqual(["python3 -m unittest tests.reported.test_example"]);
  });

  it("rejects unsupported verification commands instead of silently passing", async () => {
    const localPath = await createPythonRepo();

    const result = await runVerificationCommands(
      [],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [],
        installationId: 1
      },
      {
        requiredFiles: [],
        acceptanceCriteria: [],
        implementationChecklist: [],
        verificationChecklist: [],
        verificationCommands: ["python3 -m unittest tests.reported.test_example; rm -rf /"]
      }
    );

    expect(result.valid).toBe(false);
    expect(result.commands).toEqual([]);
    expect(result.errors.join("\n")).toContain("Unsupported verification command was not run");
  });

  it("infers changed Python test modules", async () => {
    const localPath = await createPythonRepo();

    const result = await runVerificationCommands(
      [
        {
          filePath: "tests/reported/test_example.py",
          originalContent: "",
          modifiedContent: "import unittest\n\nclass ExampleTest(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(2, 2)\n",
          explanation: "update test"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [],
        installationId: 1
      }
    );

    expect(result.valid).toBe(true);
    expect(result.commands).toEqual(['python3 -m unittest "tests.reported.test_example"']);
  });

  it("runs frontend smoke verification for static site changes without test commands", async () => {
    const localPath = await createStaticSiteRepo();

    const result = await runVerificationCommands(
      [
        {
          filePath: "script.js",
          originalContent: "document.querySelector('#target').textContent = 'ready';\n",
          modifiedContent: "document.querySelector('#target').textContent = 'updated';\n",
          explanation: "update static script"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [],
        installationId: 1
      }
    );

    expect(result.valid).toBe(true);
    expect(result.commands).toEqual([]);
  });

  it("loads linked supplemental static scripts during frontend smoke verification", async () => {
    const localPath = await createStaticSiteRepo("console.log('base');\n");
    await writeFile(
      join(localPath, "index.html"),
      "<!doctype html><html><body><div id=\"target\"></div><script src=\"script.js\"></script><script src=\"collection-modal.js\"></script></body></html>\n",
      "utf8"
    );

    const result = await runVerificationCommands(
      [
        {
          filePath: "collection-modal.js",
          originalContent: "",
          modifiedContent: "document.querySelector('#target').textContent = 'supplemental ready';\n",
          explanation: "add supplemental behavior"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [],
        installationId: 1
      }
    );

    expect(result.valid).toBe(true);
  });

  it("rejects static site changes with frontend runtime errors", async () => {
    const localPath = await createStaticSiteRepo();

    const result = await runVerificationCommands(
      [
        {
          filePath: "script.js",
          originalContent: "document.querySelector('#target').textContent = 'ready';\n",
          modifiedContent: "document.querySelector('#missing').addEventListener('click', function () {});\n",
          explanation: "wire missing control"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [],
        installationId: 1
      }
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("Frontend runtime smoke failed");
  });

  it("rejects static site changes with browser error events", async () => {
    const localPath = await createStaticSiteRepo();

    const result = await runVerificationCommands(
      [
        {
          filePath: "script.js",
          originalContent: "document.querySelector('#target').textContent = 'ready';\n",
          modifiedContent:
            "setTimeout(function () { window.dispatchEvent(new ErrorEvent('error', { message: 'async frontend failure' })); }, 0);\n",
          explanation: "wire async behavior"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [],
        installationId: 1
      }
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("async frontend failure");
  });
});

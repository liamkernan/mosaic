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

  it("ignores unsafe verification commands", async () => {
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

    expect(result.valid).toBe(true);
    expect(result.commands).toEqual([]);
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
});

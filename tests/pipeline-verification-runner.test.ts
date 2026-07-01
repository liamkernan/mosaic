import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runVerificationCommands } from "../packages/pipeline/src/verification-runner.js";
import { createTempDirTracker } from "./helpers/temp-dirs.js";

describe("runVerificationCommands", () => {
  const tempDirs = createTempDirTracker();
  const requireDockerTests = process.env.MOSAIC_REQUIRE_DOCKER_TESTS === "1";
  const dockerGatedIt = requireDockerTests ? it : it.skip;
  const fallbackOptions = { dockerAvailable: false, requireSandbox: false } as const;

  afterEach(async () => {
    await tempDirs.cleanup();
  }, 660_000);

  async function createPythonRepo(): Promise<string> {
    const localPath = await tempDirs.create("mosaic-verify-test-");
    await mkdir(join(localPath, "tests", "reported"), { recursive: true });
    await writeFile(join(localPath, "tests", "reported", "test_example.py"), "import unittest\n\nclass ExampleTest(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(1, 1)\n", "utf8");
    return localPath;
  }

  async function createStaticSiteRepo(script = "document.querySelector('#target').textContent = 'ready';\n"): Promise<string> {
    const localPath = await tempDirs.create("mosaic-verify-site-");
    await writeFile(localPath + "/index.html", "<!doctype html><html><body><div id=\"target\"></div><script src=\"script.js\"></script></body></html>\n", "utf8");
    await writeFile(localPath + "/script.js", script, "utf8");
    return localPath;
  }

  async function dockerInfoAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn("docker", ["info"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
  }

  async function requireDockerInfo(): Promise<void> {
    expect(await dockerInfoAvailable()).toBe(true);
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
      },
      fallbackOptions
    );

    expect(result.valid).toBe(true);
    expect(result.commands).toEqual(["python3 -m unittest tests.reported.test_example"]);
  }, 120_000);

  it("does not expose parent process secrets to verified test processes", async () => {
    const previousSecret = process.env.ANTHROPIC_API_KEY;
    const previousOpenAISecret = process.env.OPENAI_API_KEY;
    const previousByokSecret = process.env.MOSAIC_LLM_KEY;
    process.env.ANTHROPIC_API_KEY = "parent-secret-that-must-not-leak";
    process.env.OPENAI_API_KEY = "openai-secret-that-must-not-leak";
    process.env.MOSAIC_LLM_KEY = "byok-secret-that-must-not-leak";

    try {
      const localPath = await createPythonRepo();
      await writeFile(
        join(localPath, "tests", "reported", "test_env.py"),
        [
          "import os",
          "import unittest",
          "",
          "class EnvTest(unittest.TestCase):",
          "    def test_parent_secret_is_not_exposed(self):",
          "        self.assertIsNone(os.environ.get('ANTHROPIC_API_KEY'))",
          "        self.assertIsNone(os.environ.get('OPENAI_API_KEY'))",
          "        self.assertIsNone(os.environ.get('MOSAIC_LLM_KEY'))",
          ""
        ].join("\n"),
        "utf8"
      );

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
          verificationCommands: ["python3 -m unittest tests.reported.test_env"]
        },
        fallbackOptions
      );

      expect(result.valid).toBe(true);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previousSecret;
      }
      if (previousOpenAISecret === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAISecret;
      if (previousByokSecret === undefined) delete process.env.MOSAIC_LLM_KEY;
      else process.env.MOSAIC_LLM_KEY = previousByokSecret;
    }
  }, 120_000);

  dockerGatedIt("does not expose parent process secrets to verified test processes in Docker", async () => {
    await requireDockerInfo();

    const previousSecret = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "parent-secret-that-must-not-leak";

    try {
      const localPath = await createPythonRepo();
      await writeFile(
        join(localPath, "tests", "reported", "test_env.py"),
        [
          "import os",
          "import unittest",
          "",
          "class EnvTest(unittest.TestCase):",
          "    def test_parent_secret_is_not_exposed(self):",
          "        self.assertIsNone(os.environ.get('ANTHROPIC_API_KEY'))",
          ""
        ].join("\n"),
        "utf8"
      );

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
          verificationCommands: ["python3 -m unittest tests.reported.test_env"]
        },
        { dockerAvailable: true, requireSandbox: true }
      );

      expect(result.valid).toBe(true);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previousSecret;
      }
    }
  }, 660_000);

  dockerGatedIt("prevents verified tests from reading host files outside the mounted repo", async () => {
    await requireDockerInfo();

    const localPath = await createPythonRepo();
    const secretDir = await tempDirs.create("mosaic-host-secret-");
    const secretPath = join(secretDir, "secret.txt");
    await writeFile(secretPath, "host-secret", "utf8");

    await writeFile(
      join(localPath, "tests", "reported", "test_filesystem_isolation.py"),
      [
        "import unittest",
        "",
        "class FilesystemIsolationTest(unittest.TestCase):",
        "    def test_host_secret_is_not_visible(self):",
        "        with self.assertRaises((FileNotFoundError, PermissionError)):",
        `            open(${JSON.stringify(secretPath)}, "r", encoding="utf8").read()`,
        ""
      ].join("\n"),
      "utf8"
    );

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
        verificationCommands: ["python3 -m unittest tests.reported.test_filesystem_isolation"]
      },
      { dockerAvailable: true, requireSandbox: true }
    );

    expect(result.valid).toBe(true);
  }, 660_000);

  dockerGatedIt("denies outbound network access from verified tests", async () => {
    await requireDockerInfo();

    const localPath = await createPythonRepo();
    await writeFile(
      join(localPath, "tests", "reported", "test_network_isolation.py"),
      [
        "import socket",
        "import unittest",
        "",
        "class NetworkIsolationTest(unittest.TestCase):",
        "    def test_outbound_connection_fails(self):",
        "        with self.assertRaises(OSError):",
        "            socket.create_connection(('1.1.1.1', 443), timeout=0.25)",
        ""
      ].join("\n"),
      "utf8"
    );

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
        verificationCommands: ["python3 -m unittest tests.reported.test_network_isolation"]
      },
      { dockerAvailable: true, requireSandbox: true }
    );

    expect(result.valid).toBe(true);
  }, 660_000);

  it("fails closed when Docker isolation is required but unavailable", async () => {
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
      },
      { dockerAvailable: false, requireSandbox: true }
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("isolation unavailable");
  });

  it("falls back to the child process sandbox when Docker is unavailable and not required", async () => {
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
      },
      { dockerAvailable: false, requireSandbox: false }
    );

    expect(result.valid).toBe(true);
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
      },
      fallbackOptions
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
      },
      undefined,
      fallbackOptions
    );

    expect(result.valid).toBe(true);
    expect(result.commands).toEqual(['python3 -m unittest "tests.reported.test_example"']);
  });

  it("rejects generated change paths that escape the verification repo", async () => {
    const localPath = await createPythonRepo();
    const escapePath = join(tmpdir(), `mosaic-verification-escape-${Date.now()}.txt`);
    await rm(escapePath, { force: true });

    const result = await runVerificationCommands(
      [
        {
          filePath: `../../${basename(escapePath)}`,
          originalContent: "",
          modifiedContent: "escaped",
          explanation: "unsafe path"
        }
      ],
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
      },
      fallbackOptions
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("Unsafe generated change path rejected");
    await expect(access(escapePath)).rejects.toThrow();
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
      },
      undefined,
      fallbackOptions
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
      },
      undefined,
      fallbackOptions
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
      },
      undefined,
      fallbackOptions
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
      },
      undefined,
      fallbackOptions
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("async frontend failure");
  });
});

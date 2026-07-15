import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  inferredChangedTestCommands,
  runVerificationCommands
} from "../packages/pipeline/src/verification-runner.js";
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

  async function createGeneratedDomRepo(): Promise<string> {
    const localPath = await tempDirs.create("mosaic-verify-generated-dom-");
    await writeFile(
      join(localPath, "script.js"),
      [
        'document.querySelector("#saveFilterButton").addEventListener("click", () => {});',
        'document.querySelector("#sortToggle").addEventListener("click", () => {});',
        ""
      ].join("\n"),
      "utf8"
    );
    return localPath;
  }

  function generatedDomUnittest(includeSaveFilterButton: boolean): string {
    const saveFilterEntry = includeSaveFilterButton
      ? '  "#saveFilterButton": element(),'
      : "";
    return [
      "import subprocess",
      "import unittest",
      "from pathlib import Path",
      "",
      "NODE_TEST = r'''",
      'const fs = require("fs");',
      'const vm = require("vm");',
      "function element() { return { addEventListener() {} }; }",
      "const elements = {",
      saveFilterEntry,
      '  "#sortToggle": element(),',
      "};",
      "const document = { querySelector(selector) { return elements[selector] || null; } };",
      'vm.runInNewContext(fs.readFileSync(process.argv[1], "utf8"), { document });',
      "'''",
      "",
      "class GeneratedDomTest(unittest.TestCase):",
      "    def test_script_boots_with_independent_dom_fixture(self):",
      "        script_path = Path(__file__).resolve().parents[2] / 'script.js'",
      "        completed = subprocess.run(['node', '-e', NODE_TEST, str(script_path)], capture_output=True, text=True)",
      "        self.assertEqual(completed.returncode, 0, completed.stderr)",
      ""
    ].filter(Boolean).join("\n");
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

  it("infers pytest for top-level generated test functions", () => {
    expect(inferredChangedTestCommands([{
      filePath: "tests/generated/test_panel.py",
      originalContent: "",
      modifiedContent: "import pytest\n\ndef test_panel_opens():\n    assert True\n",
      explanation: "add generated coverage"
    }])).toEqual(['python3 -m pytest "tests/generated/test_panel.py"']);
  });

  it("replaces an incompatible planned runner with the inferred generated-test runner", async () => {
    const localPath = await createPythonRepo();
    const result = await runVerificationCommands(
      [{
        filePath: "tests/generated/test_panel.py",
        originalContent: "",
        modifiedContent: "def test_panel_opens():\n    assert True\n",
        explanation: "add generated coverage"
      }],
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
        verificationCommands: ["python3 -m unittest tests.generated.test_panel"]
      },
      fallbackOptions
    );

    expect(result.commands).toEqual(['python3 -m pytest "tests/generated/test_panel.py"']);
  });

  it("executes a generated frontend test with a complete DOM fixture independently", async () => {
    const localPath = await createGeneratedDomRepo();
    const result = await runVerificationCommands(
      [{
        filePath: "tests/generated/test_dom_boot.py",
        originalContent: "",
        modifiedContent: generatedDomUnittest(true),
        explanation: "cover frontend boot behavior"
      }],
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
    expect(result.commands).toEqual(['python3 -m unittest "tests.generated.test_dom_boot"']);
  });

  it("rejects a generated frontend test with an incomplete boot-time DOM fixture", async () => {
    const localPath = await createGeneratedDomRepo();
    const result = await runVerificationCommands(
      [{
        filePath: "tests/generated/test_dom_boot.py",
        originalContent: "",
        modifiedContent: generatedDomUnittest(false),
        explanation: "cover frontend boot behavior"
      }],
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
    expect(result.errors.join("\n")).toContain("Generated test failed independently");
    expect(result.errors.join("\n")).toContain("#saveFilterButton");
    expect(result.errors.join("\n")).not.toContain(localPath);
  });

  it("rejects a generated test command that executes zero tests", async () => {
    const localPath = await createPythonRepo();
    const result = await runVerificationCommands(
      [{
        filePath: "tests/generated/test_empty.py",
        originalContent: "",
        modifiedContent: "import unittest\n",
        explanation: "add generated coverage"
      }],
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
    expect(result.errors).toContain(
      "Generated test did not execute independently (tests/generated/test_empty.py): the runner reported zero executed tests"
    );
  });

  it("reserves a verification slot for candidate-added tests", async () => {
    const localPath = await createPythonRepo();
    await writeFile(join(localPath, "tests", "reported", "test_second.py"), "import unittest\n\nclass SecondTest(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n", "utf8");
    await writeFile(join(localPath, "tests", "reported", "test_third.py"), "import unittest\n\nclass ThirdTest(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n", "utf8");
    const result = await runVerificationCommands(
      [{
        filePath: "tests/generated/test_candidate.py",
        originalContent: "",
        modifiedContent: "import unittest\n\nclass CandidateTest(unittest.TestCase):\n    def test_failure(self):\n        self.fail('candidate executed')\n",
        explanation: "add generated coverage"
      }],
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
        verificationCommands: [
          "python3 -m unittest tests.reported.test_example",
          "python3 -m unittest tests.reported.test_second",
          "python3 -m unittest tests.reported.test_third"
        ]
      },
      fallbackOptions
    );

    expect(result.commands).toHaveLength(3);
    expect(result.commands).toContain('python3 -m unittest "tests.generated.test_candidate"');
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("candidate executed");
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

  it("rejects generated writes through leaf symlinks outside the verification repo", async () => {
    const localPath = await createPythonRepo();
    const outsidePath = await tempDirs.create("mosaic-verification-outside-");
    const sentinelPath = join(outsidePath, "sentinel.py");
    await writeFile(sentinelPath, "outside sentinel\n", "utf8");
    await symlink(sentinelPath, join(localPath, "linked.py"));

    const result = await runVerificationCommands(
      [
        {
          filePath: "linked.py",
          originalContent: "outside sentinel\n",
          modifiedContent: "overwritten\n",
          explanation: "unsafe symlink write"
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
    expect(result.errors.join("\n")).toContain("Unsafe generated change path rejected: linked.py");
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("outside sentinel\n");
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

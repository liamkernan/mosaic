import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("counts localized edits in large files without charging unchanged prefix and suffix lines", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(tempDir);
    await mkdir(join(tempDir, "src"), { recursive: true });
    const originalContent = [
      ...Array.from({ length: 300 }, (_, index) => `const prefix${index} = ${index};`),
      "const target = 'old';",
      ...Array.from({ length: 300 }, (_, index) => `const suffix${index} = ${index};`)
    ].join("\n");
    const modifiedContent = originalContent.replace("const target = 'old';", "const target = 'new';");
    await writeFile(join(tempDir, "src", "large.ts"), originalContent);

    const result = await validate(
      [
        {
          filePath: "src/large.ts",
          originalContent,
          modifiedContent,
          explanation: "update one localized value"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath: tempDir,
        fileTree: [{ path: "src/large.ts", type: "file" }],
        installationId: 1
      },
      {
        maxChangedLines: 3,
        maxLinesAdded: 10
      }
    );

    expect(result.valid).toBe(true);
  });

  it("counts reordered changed-window lines using line-level common subsequences", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(tempDir);
    const originalContent = ["alpha", "beta", "gamma", "delta"].join("\n");
    const modifiedContent = ["alpha", "gamma", "beta", "delta"].join("\n");
    await writeFile(join(tempDir, "notes.md"), originalContent);

    const result = await validate(
      [
        {
          filePath: "notes.md",
          originalContent,
          modifiedContent,
          explanation: "swap adjacent notes"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath: tempDir,
        fileTree: [{ path: "notes.md", type: "file" }],
        installationId: 1
      },
      {
        maxChangedLines: 2,
        maxLinesAdded: 10
      }
    );

    expect(result.valid).toBe(true);
  });

  it("rejects generated change paths outside the repository", async () => {
    const result = await validate(
      [
        {
          filePath: "../outside.txt",
          originalContent: "",
          modifiedContent: "outside",
          explanation: "unsafe path"
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
    expect(result.errors.join("\n")).toContain("Unsafe generated change path rejected");
  });

  it("rejects Python syntax errors before verification", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await writeFile(join(localPath, "service.py"), "def queue():\n    return []\n", "utf8");

    const result = await validate(
      [
        {
          filePath: "service.py",
          originalContent: "def queue():\n    return []\n",
          modifiedContent: "def queue(:\n    return []\n",
          explanation: "update queue"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [{ path: "service.py", type: "file" }],
        installationId: 1
      }
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("Syntax validation failed for service.py");
  });

  it("rejects changes that weaken existing test assertions", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await mkdir(join(localPath, "tests", "reported"), { recursive: true });
    await writeFile(join(localPath, "tests", "reported", "test_001_sla_sort.py"), "def test_sla_sort_orders_by_due_at(self):\n    self.assertEqual(urgent['id'], queue[0]['id'])\n", "utf8");

    const result = await validate(
      [
        {
          filePath: "tests/reported/test_001_sla_sort.py",
          originalContent:
            "def test_sla_sort_orders_by_due_at(self):\n    self.assertEqual(urgent['id'], queue[0]['id'])\n",
          modifiedContent:
            "def test_sla_sort_orders_by_due_at(self):\n    pass\n",
          explanation: "make test pass"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [{ path: "tests/reported/test_001_sla_sort.py", type: "file" }],
        installationId: 1
      }
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("weakens existing test assertions");
  });

  it("rejects skipped or trivial generated tests", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await mkdir(join(localPath, "tests", "reported"), { recursive: true });
    await writeFile(join(localPath, "tests", "reported", "test_001_sla_sort.py"), "", "utf8");

    const result = await validate(
      [
        {
          filePath: "tests/reported/test_001_sla_sort.py",
          originalContent: "",
          modifiedContent:
            "import unittest\n\n@unittest.skip('flaky')\ndef test_sla_sort_orders_by_due_at():\n    assert True\n",
          explanation: "add regression test"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [{ path: "tests/reported/test_001_sla_sort.py", type: "file" }],
        installationId: 1
      }
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("skipped or trivial test assertions");
  });

  it("accepts generated tests that preserve and add meaningful assertions", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await mkdir(join(localPath, "tests", "reported"), { recursive: true });
    await writeFile(join(localPath, "tests", "reported", "test_001_sla_sort.py"), "def test_sla_sort_orders_by_due_at(self):\n    self.assertEqual(urgent['id'], queue[0]['id'])\n", "utf8");

    const result = await validate(
      [
        {
          filePath: "tests/reported/test_001_sla_sort.py",
          originalContent:
            "def test_sla_sort_orders_by_due_at(self):\n    self.assertEqual(urgent['id'], queue[0]['id'])\n",
          modifiedContent:
            "def test_sla_sort_orders_by_due_at(self):\n    self.assertEqual(urgent['id'], queue[0]['id'])\n    assert queue[0]['sla_due_at'] < queue[1]['sla_due_at']\n",
          explanation: "strengthen regression test"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [{ path: "tests/reported/test_001_sla_sort.py", type: "file" }],
        installationId: 1
      }
    );

    expect(result.valid).toBe(true);
  });

  it("rejects newly added inert links", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await writeFile(join(localPath, "index.html"), "<main></main>\n", "utf8");

    const result = await validate(
      [
        {
          filePath: "index.html",
          originalContent: "<main></main>\n",
          modifiedContent: '<main><a href="#" class="text-link">Read all articles</a></main>\n',
          explanation: "add dead journal link"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [{ path: "index.html", type: "file" }],
        installationId: 1
      }
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("adds inert link");
  });

  it("rejects newly added click-only containers", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await writeFile(join(localPath, "index.html"), "<main></main>\n", "utf8");

    const result = await validate(
      [
        {
          filePath: "index.html",
          originalContent: "<main></main>\n",
          modifiedContent:
            '<main><article class="journal-card journal-card-clickable" data-article="shelf-layering">Guide</article></main>\n',
          explanation: "make journal card clickable"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [{ path: "index.html", type: "file" }],
        installationId: 1
      }
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("non-interactive container");
  });

  it("accepts native interactive card controls", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await writeFile(join(localPath, "index.html"), "<main></main>\n", "utf8");

    const result = await validate(
      [
        {
          filePath: "index.html",
          originalContent: "<main></main>\n",
          modifiedContent:
            '<main><button class="journal-card journal-card-clickable" data-article="shelf-layering" type="button">Guide</button></main>\n',
          explanation: "make journal card a button"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [{ path: "index.html", type: "file" }],
        installationId: 1
      }
    );

    expect(result.valid).toBe(true);
  });

  it("rejects accessible non-native controls without keyboard activation behavior", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await writeFile(join(localPath, "index.html"), "<main></main>\n", "utf8");
    await writeFile(join(localPath, "script.js"), "console.log('ready');\n", "utf8");

    const result = await validate(
      [
        {
          filePath: "index.html",
          originalContent: "<main></main>\n",
          modifiedContent:
            '<main><article class="journal-card journal-card-clickable" role="button" tabindex="0" data-article="shelf-layering">Guide</article></main>\n',
          explanation: "make journal card accessible"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [
          { path: "index.html", type: "file" },
          { path: "script.js", type: "file" }
        ],
        installationId: 1
      }
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("accessible non-native control");
    expect(result.errors.join("\n")).toContain("keyboard activation behavior");
  });

  it("accepts accessible non-native controls with Enter and Space keyboard activation", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await writeFile(join(localPath, "index.html"), "<main></main>\n", "utf8");
    await writeFile(join(localPath, "script.js"), "console.log('ready');\n", "utf8");

    const result = await validate(
      [
        {
          filePath: "index.html",
          originalContent: "<main></main>\n",
          modifiedContent:
            '<main><article class="journal-card journal-card-clickable" role="button" tabindex="0" data-article="shelf-layering">Guide</article></main>\n',
          explanation: "make journal card accessible"
        },
        {
          filePath: "script.js",
          originalContent: "console.log('ready');\n",
          modifiedContent:
            "document.querySelectorAll('.journal-card-clickable').forEach((card) => {\n" +
            "  card.addEventListener('keydown', (event) => {\n" +
            "    if (event.key === 'Enter' || event.key === ' ') card.click();\n" +
            "  });\n" +
            "});\n",
          explanation: "add keyboard activation"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [
          { path: "index.html", type: "file" },
          { path: "script.js", type: "file" }
        ],
        installationId: 1
      }
    );

    expect(result.valid).toBe(true);
  });

  it("accepts stylesheet insertions that shift existing lines", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    const originalContent = Array.from({ length: 830 }, (_, index) => `.item-${index} { color: black; }`).join("\n");
    const insertedStyles = Array.from({ length: 24 }, (_, index) => `.modal-content-${index} { display: block; }`).join("\n");
    const modifiedContent = `${insertedStyles}\n${originalContent}`;
    await writeFile(join(localPath, "styles.css"), originalContent, "utf8");

    const result = await validate(
      [
        {
          filePath: "styles.css",
          originalContent,
          modifiedContent,
          explanation: "add modal styles"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [{ path: "styles.css", type: "file" }],
        installationId: 1
      }
    );

    expect(result.valid).toBe(true);
  });

  it("still rejects broad rewrites", async () => {
    const originalContent = Array.from({ length: 300 }, (_, index) => `.item-${index} { color: black; }`).join("\n");
    const modifiedContent = Array.from({ length: 300 }, (_, index) => `.replacement-${index} { color: white; }`).join("\n");

    const result = await validate(
      [
        {
          filePath: "styles.css",
          originalContent,
          modifiedContent,
          explanation: "rewrite styles"
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
    expect(result.errors.join("\n")).toContain("is too large");
  });

  it("uses configured block patterns", async () => {
    const result = await validate(
      [
        {
          filePath: "src/index.ts",
          originalContent: "export const safeValue = 1;\n",
          modifiedContent: "export const safeValue = 1;\ndangerousCall();\n",
          explanation: "custom unsafe"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath: process.cwd(),
        fileTree: [],
        installationId: 1
      },
      {
        blockPatterns: ["dangerousCall("]
      }
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("dangerousCall(");
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
    expect(result.errors.join("\n")).toContain("does not update a stylesheet");
  });

  it("rejects modal UI changes that do not add matching behavior", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await writeFile(join(localPath, "index.html"), "<div>before</div>\n", "utf8");
    await writeFile(join(localPath, "styles.css"), ".journal-modal { display: block; }\n", "utf8");
    await writeFile(join(localPath, "script.js"), "console.log('ready');\n", "utf8");

    const result = await validate(
      [
        {
          filePath: "index.html",
          originalContent: "<div>before</div>\n",
          modifiedContent:
            '<button data-article="shelf-styling">Open</button><div class="journal-modal"></div>\n',
          explanation: "add journal modal"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [
          { path: "index.html", type: "file" },
          { path: "styles.css", type: "file" },
          { path: "script.js", type: "file" }
        ],
        installationId: 1
      }
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("does not update a script");
  });

  it("rejects modal UI changes that only add open behavior", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await writeFile(join(localPath, "index.html"), "<div>before</div>\n", "utf8");
    await writeFile(join(localPath, "styles.css"), ".journal-modal { display: block; }\n", "utf8");
    await writeFile(join(localPath, "script.js"), "console.log('ready');\n", "utf8");

    const result = await validate(
      [
        {
          filePath: "index.html",
          originalContent: "<div>before</div>\n",
          modifiedContent:
            '<button data-article="shelf-styling">Open</button><div class="journal-modal"></div>\n',
          explanation: "add journal modal"
        },
        {
          filePath: "script.js",
          originalContent: "console.log('ready');\n",
          modifiedContent: "document.querySelector('.journal-modal').classList.add('is-open');\n",
          explanation: "only opens journal modal"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [
          { path: "index.html", type: "file" },
          { path: "styles.css", type: "file" },
          { path: "script.js", type: "file" }
        ],
        installationId: 1
      }
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("without complete open/close/keyboard behavior");
  });

  it("accepts modal UI changes with matching styles and behavior", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await writeFile(join(localPath, "index.html"), "<div>before</div>\n", "utf8");
    await writeFile(join(localPath, "styles.css"), ".journal-modal { display: block; }\n", "utf8");
    await writeFile(join(localPath, "script.js"), "console.log('ready');\n", "utf8");

    const result = await validate(
      [
        {
          filePath: "index.html",
          originalContent: "<div>before</div>\n",
          modifiedContent:
            '<button data-article="shelf-styling">Open</button><div class="journal-modal"></div>\n',
          explanation: "add journal modal"
        },
        {
          filePath: "script.js",
          originalContent: "console.log('ready');\n",
          modifiedContent:
            "const journalModal = document.querySelector('.journal-modal');\n" +
            "document.querySelector('[data-article]').addEventListener('click', () => journalModal.classList.add('is-open'));\n" +
            "document.querySelector('.journal-modal').addEventListener('click', () => journalModal.classList.remove('is-open'));\n" +
            "document.addEventListener('keydown', (event) => { if (event.key === 'Escape') journalModal.classList.remove('is-open'); });\n",
          explanation: "wire journal modal behavior"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [
          { path: "index.html", type: "file" },
          { path: "styles.css", type: "file" },
          { path: "script.js", type: "file" }
        ],
        installationId: 1
      }
    );

    expect(result.valid).toBe(true);
  });

  it("accepts modal UI changes when related styles and behavior are added without every content token", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await writeFile(join(localPath, "index.html"), "<div>before</div>\n", "utf8");
    await writeFile(join(localPath, "styles.css"), ".journal-card { display: block; }\n", "utf8");
    await writeFile(join(localPath, "script.js"), "console.log('ready');\n", "utf8");

    const result = await validate(
      [
        {
          filePath: "index.html",
          originalContent: "<div>before</div>\n",
          modifiedContent:
            '<button data-article="shelf-styling">Open</button><div class="article-modal-overlay"><article class="article-modal"><button class="article-modal-close">Close</button><div class="article-modal-body"></div></article></div>\n',
          explanation: "add article modal markup"
        },
        {
          filePath: "styles.css",
          originalContent: ".journal-card { display: block; }\n",
          modifiedContent:
            ".journal-card { display: block; }\n.article-modal-overlay { position: fixed; inset: 0; display: grid; }\n.article-modal { max-width: 720px; background: #fff; }\n.article-modal-close { display: inline-flex; }\n",
          explanation: "style article modal"
        },
        {
          filePath: "script.js",
          originalContent: "console.log('ready');\n",
          modifiedContent:
            "const articleModalOverlay = document.querySelector('.article-modal-overlay');\n" +
            "document.querySelectorAll('[data-article]').forEach((button) => button.addEventListener('click', () => articleModalOverlay.classList.add('is-open')));\n" +
            "document.querySelector('.article-modal-close').addEventListener('click', () => articleModalOverlay.classList.remove('is-open'));\n" +
            "document.addEventListener('keydown', (event) => { if (event.key === 'Escape') articleModalOverlay.classList.remove('is-open'); });\n",
          explanation: "wire article modal behavior"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [
          { path: "index.html", type: "file" },
          { path: "styles.css", type: "file" },
          { path: "script.js", type: "file" }
        ],
        installationId: 1
      }
    );

    expect(result.valid).toBe(true);
  });

  it("allows moderately sized static UI changes under the default added-line budget", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    const originalContent = "<main></main>\n";
    await writeFile(join(localPath, "index.html"), originalContent, "utf8");
    const modifiedContent = [
      "<main>",
      ...Array.from({ length: 270 }, (_, index) => `<section data-row="${index}">Row ${index}</section>`),
      "</main>"
    ].join("\n");

    const result = await validate(
      [
        {
          filePath: "index.html",
          originalContent,
          modifiedContent,
          explanation: "add a moderate static UI surface"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [{ path: "index.html", type: "file" }],
        installationId: 1
      }
    );

    expect(result.valid).toBe(true);
  });

  it("accepts modal behavior and styles in supplemental frontend assets", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await writeFile(join(localPath, "index.html"), "<main></main>\n", "utf8");
    await writeFile(join(localPath, "styles.css"), ".collection-card { display: block; }\n", "utf8");
    await writeFile(join(localPath, "script.js"), "console.log('ready');\n", "utf8");

    const result = await validate(
      [
        {
          filePath: "index.html",
          originalContent: "<main></main>\n",
          modifiedContent:
            '<link rel="stylesheet" href="./collection-modal.css"><main><button data-collection="kitchen">Kitchen</button><div class="collection-modal-overlay"><dialog class="collection-modal"></dialog></div><script src="./collection-modal.js"></script></main>\n',
          explanation: "add modal markup"
        },
        {
          filePath: "collection-modal.css",
          originalContent: "",
          modifiedContent: ".collection-modal-overlay { position: fixed; inset: 0; }\n.collection-modal { display: block; }\n",
          explanation: "style collection modal"
        },
        {
          filePath: "collection-modal.js",
          originalContent: "",
          modifiedContent:
            "const collectionModal = document.querySelector('.collection-modal');\n" +
            "document.querySelectorAll('[data-collection]').forEach((button) => button.addEventListener('click', () => collectionModal.showModal()));\n" +
            "document.querySelector('.collection-modal-overlay').addEventListener('click', () => collectionModal.close());\n" +
            "document.addEventListener('keydown', (event) => { if (event.key === 'Escape') collectionModal.close(); });\n",
          explanation: "wire collection modal behavior"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [
          { path: "index.html", type: "file" },
          { path: "styles.css", type: "file" },
          { path: "script.js", type: "file" }
        ],
        installationId: 1
      }
    );

    expect(result.valid).toBe(true);
  });

  it("rejects new static frontend assets that are not linked from html", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await writeFile(join(localPath, "index.html"), "<main></main>\n", "utf8");

    const result = await validate(
      [
        {
          filePath: "collection-modal.js",
          originalContent: "",
          modifiedContent: "document.body.dataset.ready = 'true';\n",
          explanation: "add modal behavior"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [{ path: "index.html", type: "file" }],
        installationId: 1
      }
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("New static asset collection-modal.js is not linked from index.html");
  });

  it("rejects changed static scripts that query missing html hooks", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await writeFile(join(localPath, "index.html"), '<main><button class="collection-card">Kitchen</button><script src="./collection-modal.js"></script></main>\n', "utf8");

    const result = await validate(
      [
        {
          filePath: "index.html",
          originalContent: "<main></main>\n",
          modifiedContent: '<main><button class="collection-card">Kitchen</button><script src="./collection-modal.js"></script></main>\n',
          explanation: "add modal script"
        },
        {
          filePath: "collection-modal.js",
          originalContent: "",
          modifiedContent:
            "document.getElementById('collectionModalClose').addEventListener('click', function () {});\ndocument.querySelectorAll('.coll-card-btn').forEach(function (button) { button.addEventListener('click', function () {}); });\n",
          explanation: "wire modal behavior"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [{ path: "index.html", type: "file" }],
        installationId: 1
      }
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("queries missing HTML id(s): collectionModalClose");
    expect(result.errors.join("\n")).toContain("queries selector(s) with no matching HTML: .coll-card-btn");
  });

  it("rejects script-only changes that query selectors missing from existing html", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await writeFile(join(localPath, "index.html"), '<main><button class="collection-card">Kitchen</button><script src="./collection-modal.js"></script></main>\n', "utf8");

    const result = await validate(
      [
        {
          filePath: "collection-modal.js",
          originalContent: "console.log('ready');\n",
          modifiedContent:
            "document.querySelectorAll('.coll-card-btn').forEach(function (button) { button.addEventListener('click', function () {}); });\n",
          explanation: "wire modal behavior"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [
          { path: "index.html", type: "file" },
          { path: "collection-modal.js", type: "file" }
        ],
        installationId: 1
      }
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("queries selector(s) with no matching HTML: .coll-card-btn");
  });

  it("accepts changed static scripts that query existing class and data-attribute hooks", async () => {
    const localPath = await mkdtemp(join(tmpdir(), "mosaic-validator-"));
    tempDirs.push(localPath);
    await writeFile(
      join(localPath, "index.html"),
      '<main><button class="collection-card" data-collection="kitchen">Kitchen</button><script src="./collection-modal.js"></script></main>\n',
      "utf8"
    );

    const result = await validate(
      [
        {
          filePath: "index.html",
          originalContent: "<main></main>\n",
          modifiedContent:
            '<main><button class="collection-card" data-collection="kitchen">Kitchen</button><script src="./collection-modal.js"></script></main>\n',
          explanation: "add collection card hook"
        },
        {
          filePath: "collection-modal.js",
          originalContent: "",
          modifiedContent:
            "document.querySelectorAll('.collection-card[data-collection]').forEach(function (button) { button.addEventListener('click', function () {}); });\n",
          explanation: "wire modal behavior"
        }
      ],
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        localPath,
        fileTree: [{ path: "index.html", type: "file" }],
        installationId: 1
      }
    );

    expect(result.errors.join("\n")).not.toContain(".collection-card[data-collection]");
  });

  it("rejects changed Python files that call new sibling module helpers without importing them", async () => {
    const result = await validate(
      [
        {
          filePath: "app/service.py",
          originalContent: "def list_requests(conn):\n    return []\n",
          modifiedContent: "def list_requests(conn):\n    return []\n\ndef get_metrics(conn):\n    return {\"ok\": True}\n",
          explanation: "add metrics helper"
        },
        {
          filePath: "app/web.py",
          originalContent: "from .service import list_requests\n\ndef route(conn):\n    return list_requests(conn)\n",
          modifiedContent: "from .service import list_requests\n\ndef route(conn, path):\n    if path == \"/metrics\":\n        return get_metrics(conn)\n    return list_requests(conn)\n",
          explanation: "add metrics route"
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
    expect(result.errors.join("\n")).toContain("calls get_metrics from service.py but does not import or define get_metrics");
  });
});

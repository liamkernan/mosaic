import { describe, expect, it } from "vitest";

import { pruneChangesToPlanScope, validatePlanCompletion } from "../packages/pipeline/src/plan-completion-validator.js";
import { buildImplementationPlan } from "./helpers/pipeline.js";

const basePlan = buildImplementationPlan();

describe("validatePlanCompletion", () => {
  it("reports a structured missing CSS layer before frontend verification", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "index.html",
          originalContent: "<main></main>\n",
          modifiedContent: '<main><button class="product-card" data-product="vase">Details</button><dialog id="product-details"></dialog></main>\n',
          explanation: "add accessible product details markup"
        },
        {
          filePath: "script.js",
          originalContent: "",
          modifiedContent: "document.querySelectorAll('.product-card').forEach((button) => button.addEventListener('click', openProductDetails));\n",
          explanation: "wire product details behavior"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [
          { path: "index.html", reason: "add product details markup" },
          { path: "script.js", reason: "add product details behavior" },
          { path: "styles.css", reason: "style the product details dialog" }
        ]
      }
    );

    expect(errors).toContain(
      "[missing-frontend-layer:css] Implementation plan requires a CSS layer, but generated changes omit it. Planned CSS files: styles.css"
    );
  });

  it("accepts complete planned HTML, JavaScript, and CSS layers", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "index.html",
          originalContent: "<main></main>\n",
          modifiedContent: '<main><button class="product-card" data-product="vase">Details</button><dialog id="product-details"></dialog></main>\n',
          explanation: "add accessible product details markup"
        },
        {
          filePath: "script.js",
          originalContent: "",
          modifiedContent: "document.querySelectorAll('.product-card').forEach((button) => button.addEventListener('click', openProductDetails));\n",
          explanation: "wire product details behavior"
        },
        {
          filePath: "styles.css",
          originalContent: "",
          modifiedContent: ".product-card { cursor: pointer; }\n#product-details { padding: 1rem; }\n",
          explanation: "style product details"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [
          { path: "index.html", reason: "add product details markup" },
          { path: "script.js", reason: "add product details behavior" },
          { path: "styles.css", reason: "style the product details dialog" }
        ]
      }
    );

    expect(errors).toEqual([]);
  });

  it("does not require JavaScript edits when a planned script is verification-only", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "index.html",
          originalContent: '<button id="cartButton">Bag</button>\n',
          modifiedContent: '<button id="cartButton" aria-label="Open cart">Bag</button>\n',
          explanation: "name the existing cart control"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [
          { path: "index.html", reason: "Add an explicit accessible name to the cart button." },
          {
            path: "script.js",
            reason: "Verify the existing cart-button click handling and drawer state behavior remain unchanged after the markup accessibility update."
          }
        ],
        acceptanceCriteria: ["The cart button has a clear accessible name."],
        implementationChecklist: [
          "Give #cartButton an explicit accessible name.",
          "Preserve #cartButton's existing aria-expanded state and JavaScript event behavior."
        ]
      }
    );

    expect(errors).toEqual([]);
  });

  it("does not require behavior-layer edits for a copy-only verification file", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "index.html",
          originalContent: '<h2>Your bag is empty</h2>\n',
          modifiedContent: '<h2>Your cart is ready for something special</h2>\n',
          explanation: "update the requested empty-cart copy"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [
          { path: "index.html", reason: "Contains the empty-cart headline shown to shoppers." },
          {
            path: "script.js",
            reason: "Owns cart state and must be checked to ensure the copy-only change does not alter cart behavior."
          }
        ],
        acceptanceCriteria: ["The empty-cart headline uses the requested copy."],
        implementationChecklist: ["Replace only the empty-cart text content."]
      }
    );

    expect(errors).toEqual([]);
  });

  it("recognizes a related behavior file that must remain unchanged as verification-only", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "index.html",
          originalContent: '<button id="cartButton">Bag</button>\n',
          modifiedContent: '<button id="cartButton" aria-label="Open cart">Bag</button>\n',
          explanation: "name the existing cart control"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [
          { path: "index.html", reason: "Defines the cart button markup and its accessible name." },
          {
            path: "script.js",
            reason: "Contains the cart control's interaction/state behavior, which must remain unchanged when the accessible name is added."
          }
        ],
        acceptanceCriteria: ["The cart control has a meaningful accessible name."],
        implementationChecklist: [
          "Add an accessible name to #cartButton.",
          "Do not alter the existing cart drawer toggle logic in script.js."
        ]
      }
    );

    expect(errors).toEqual([]);

    const preservationLedErrors = validatePlanCompletion(
      [
        {
          filePath: "index.html",
          originalContent: '<button id="cartButton">Bag</button>\n',
          modifiedContent: '<button id="cartButton" aria-label="Open cart">Bag</button>\n',
          explanation: "name the existing cart control"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [
          { path: "index.html", reason: "Add a clear accessible name to the cart button." },
          {
            path: "script.js",
            reason: "Preserve the existing cart-button interaction and drawer state behavior while the button's accessible name is updated."
          }
        ],
        acceptanceCriteria: ["The cart control has a meaningful accessible name."],
        implementationChecklist: [
          "Give #cartButton an explicit accessible name.",
          "Do not change the cart button click handling or drawer behavior in script.js."
        ]
      }
    );

    expect(preservationLedErrors).toEqual([]);

    const actionLedErrors = validatePlanCompletion(
      [
        {
          filePath: "tests/service.test.ts",
          originalContent: "",
          modifiedContent: "it('preserves the API', () => expect(true).toBe(true));\n",
          explanation: "cover the public API"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [
          {
            path: "src/service.ts",
            reason: "Update the service implementation while preserving its public API."
          }
        ],
        acceptanceCriteria: ["The service fixes the reported behavior."],
        implementationChecklist: [
          "Update src/service.ts to fix the behavior.",
          "Do not change the public API in src/service.ts."
        ]
      }
    );

    expect(actionLedErrors.join("\n")).toContain("requires runtime/source changes");
  });

  it("rejects substituted ordered tie-breakers from acceptance criteria", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "mosaic_demo/service.py",
          originalContent: "order_by = \"sr.created_at ASC\"\n",
          modifiedContent: "order_by = \"sr.sla_due_at ASC, sr.id ASC\"\n",
          explanation: "sort by SLA due date"
        },
        {
          filePath: "tests/reported/test_001_sla_sort.py",
          originalContent: "def test_sla(): pass\n",
          modifiedContent: "def test_sla(): assert True\n",
          explanation: "update reported test"
        }
      ],
      {
        ...basePlan,
        acceptanceCriteria: ["`list_requests(..., sort=\"sla\")` should order by `sla_due_at ASC`, then `created_at ASC`."],
        verificationChecklist: ["Add a unittest covering the SLA tie-breaker."]
      }
    );

    expect(errors.join("\n")).toContain("sla_due_at ASC, created_at ASC");
  });

  it("accepts required ordered terms with an extra tertiary tie-breaker", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "mosaic_demo/service.py",
          originalContent: "order_by = \"sr.created_at ASC\"\n",
          modifiedContent: "order_by = \"sr.sla_due_at ASC, sr.created_at ASC, sr.id ASC\"\n",
          explanation: "sort by SLA due date"
        },
        {
          filePath: "tests/reported/test_001_sla_sort.py",
          originalContent: "def test_sla(): pass\n",
          modifiedContent: "def test_sla_tie_breaker(): assert True\n",
          explanation: "cover tie-breaker"
        }
      ],
      {
        ...basePlan,
        acceptanceCriteria: ["Requests should order by `sla_due_at ASC`, then `created_at ASC`."],
        verificationChecklist: ["Add a unittest covering the SLA tie-breaker."]
      }
    );

    expect(errors).toEqual([]);
  });

  it("requires test changes when the plan asks for behavioral sort coverage", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "src/service.ts",
          originalContent: "return items;\n",
          modifiedContent: "return items.sort();\n",
          explanation: "sort queue"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [{ path: "tests/service.test.ts", reason: "coverage for queue sort" }],
        acceptanceCriteria: ["Queue sort orders urgent items first."],
        verificationChecklist: ["Add a test for queue sorting."]
      }
    );

    expect(errors.join("\n")).toContain("does not modify any test/spec file");
  });

  it("rejects test-only changes when the plan requires runtime files", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "tests/reported/test_001_sla_sort.py",
          originalContent: "def test_sla(): pass\n",
          modifiedContent: "def test_sla_sort_orders_by_due_at(): assert True\n",
          explanation: "add regression coverage"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [
          { path: "mosaic_demo/service.py", reason: "fix queue sorting logic" },
          { path: "tests/reported/test_001_sla_sort.py", reason: "cover the reported sort regression" }
        ],
        acceptanceCriteria: ["SLA sort should show the next breach first."],
        verificationChecklist: ["Run the reported regression test."]
      }
    );

    expect(errors.join("\n")).toContain("requires runtime/source changes");
  });

  it("requires a direct planned runtime change instead of only an adjacent source companion", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "src/unrelated.ts",
          originalContent: "",
          modifiedContent: "export const unrelated = true;\n",
          explanation: "add an adjacent helper"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [{ path: "src/service.ts", reason: "fix the reported service behavior" }],
        acceptanceCriteria: ["The reported service behavior is corrected."]
      }
    );

    expect(errors).toContain(
      "Implementation plan requires a change to at least one planned runtime/source file, but generated changes only add companion files"
    );
  });

  it("rejects generated changes outside the planned file scope", () => {
    const changes = [
      {
        filePath: "packages/addon/src/test-utils.ts",
        originalContent: "export const getGlobals = server.commands.getInitialGlobals;\n",
        modifiedContent: "export async function getGlobals() {\n  return (await import('@vitest/browser/context').catch(() => ({ server: null }))).server?.commands?.getInitialGlobals?.() ?? {};\n}\n",
        explanation: "guard browser context import"
      },
      {
        filePath: "examples/ember/app/index.html",
        originalContent: "<body></body>\n",
        modifiedContent: "<body><script src=\"../packages/addon/src/test-utils.test.ts\"></script></body>\n",
        explanation: "load the generated test"
      }
    ];
    const plan = {
      ...basePlan,
      requiredFiles: [{ path: "packages/addon/src/test-utils.ts", reason: "fix browser context fallback" }],
      acceptanceCriteria: ["Non-browser vitest runs should not import browser-only context at module scope."]
    };
    const errors = validatePlanCompletion(
      changes,
      plan
    );
    const scopedChanges = pruneChangesToPlanScope(
      changes,
      plan
    );

    expect(errors.join("\n")).toContain("examples/ember/app/index.html");
    expect(errors.join("\n")).toContain("outside the implementation plan scope");
    expect(scopedChanges.map((change) => change.filePath)).toEqual(["packages/addon/src/test-utils.ts"]);
  });

  it("allows adjacent generated test companions for planned behavioral source changes", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "packages/addon/src/test-utils.ts",
          originalContent: "export const getGlobals = server.commands.getInitialGlobals;\n",
          modifiedContent: "export async function getGlobals() {\n  return (await import('@vitest/browser/context').catch(() => ({ server: null }))).server?.commands?.getInitialGlobals?.() ?? {};\n}\n",
          explanation: "guard browser context import"
        },
        {
          filePath: "packages/addon/src/test-utils.test.ts",
          originalContent: "",
          modifiedContent: "import { expect, it } from 'vitest';\nit('falls back without browser context', async () => expect(await getGlobals()).toEqual({}));\n",
          explanation: "cover the fallback"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [
          { path: "packages/addon/src/test-utils.ts", reason: "fix browser context fallback" },
          { path: "packages/addon/src/test-utils.test.ts", reason: "add behavioral regression coverage" }
        ],
        acceptanceCriteria: ["Non-browser vitest runs should not import browser-only context at module scope."],
        verificationChecklist: ["Add a vitest regression test for the fallback."]
      }
    );

    expect(errors).toEqual([]);
  });

  it("allows package config companions above planned source files", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "packages/addon/src/runner.ts",
          originalContent: "export function run() {}\n",
          modifiedContent: "import { helper } from './helper';\nexport function run() { return helper(); }\n",
          explanation: "use helper"
        },
        {
          filePath: "packages/addon/package.json",
          originalContent: "{\"dependencies\":{}}\n",
          modifiedContent: "{\"dependencies\":{\"left-pad\":\"1.3.0\"}}\n",
          explanation: "add dependency"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [{ path: "packages/addon/src/runner.ts", reason: "fix runner behavior" }],
        acceptanceCriteria: ["Runner should use the helper behavior."]
      }
    );

    expect(errors).toEqual([]);
  });

  it("does not let documentation-only changes satisfy requested endpoint routing", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "README.md",
          originalContent: "",
          modifiedContent: "The service exposes GET /metrics.\n",
          explanation: "document metrics endpoint"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [{ path: "mosaic_demo/web.py", reason: "route the metrics endpoint" }],
        acceptanceCriteria: ["Expose a dashboard endpoint."]
      },
      "The support lead wants GET /metrics with open request counts."
    );

    expect(errors.join("\n")).toContain("requires runtime/source changes");
    expect(errors.join("\n")).toContain("endpoint path /metrics");
  });

  it("allows test-only plans when no runtime files are required", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "tests/reported/test_001_sla_sort.py",
          originalContent: "",
          modifiedContent: "def test_sla_sort_orders_by_due_at(): assert True\n",
          explanation: "add regression coverage"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [{ path: "tests/reported/test_001_sla_sort.py", reason: "add coverage for the reported sort regression" }],
        acceptanceCriteria: ["Add regression coverage for SLA sorting."],
        verificationChecklist: ["Run the new regression test."]
      }
    );

    expect(errors).toEqual([]);
  });

  it("does not require test edits when an existing reported test is only listed for verification", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "mosaic_demo/service.py",
          originalContent: "return create_request()\n",
          modifiedContent: "existing = select_by_external_ref(source, external_ref)\nif existing:\n    update_existing_request(existing)\nreturn create_request()\n",
          explanation: "make retry intake idempotent"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [{ path: "tests/reported/test_002_idempotent_external_ref.py", reason: "reported regression test" }],
        acceptanceCriteria: ["Slack retries with the same source and external ref update the existing request."],
        verificationChecklist: ["Run python3 -m unittest tests.reported.test_002_idempotent_external_ref."]
      }
    );

    expect(errors).toEqual([]);
  });

  it("rejects idempotency fixes that do not look up and update the existing record", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "mosaic_demo/service.py",
          originalContent: "insert_request(source, external_ref)\n",
          modifiedContent: "insert_request(source, external_ref)\n",
          explanation: "touch request creation"
        }
      ],
      {
        ...basePlan,
        acceptanceCriteria: ["Slack retries with the same source and external ref update the existing request instead of creating a duplicate."],
        verificationChecklist: ["Run the reported idempotency regression test."]
      }
    );

    expect(errors.join("\n")).toContain("idempotent duplicate/retry update path");
  });

  it("does not mistake an idempotent close operation for keyed intake deduplication", () => {
    const errors = validatePlanCompletion(
      [{
        filePath: "mosaic_demo/service.py",
        originalContent: "event_type = 'updated'\n",
        modifiedContent: "event_type = 'closed'\n",
        explanation: "correct the close audit label"
      }],
      {
        ...basePlan,
        requiredFiles: [{ path: "mosaic_demo/service.py", reason: "update close_request audit behavior" }],
        acceptanceCriteria: ["The close-request behavior remains idempotent for requests already marked closed."],
        verificationChecklist: ["Verify a repeated close leaves the audit-event count unchanged."]
      }
    );

    expect(errors).not.toContain(
      "Acceptance criteria require an idempotent duplicate/retry update path, but no implementation change appears to look up and update an existing record by the idempotency key"
    );
  });

  it("requires JavaScript when a static frontend checklist explicitly calls for DOM rendering", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "index.html",
          originalContent: "<main></main>\n",
          modifiedContent: "<main><a href='product.html?slug=vase'>Vase</a></main>\n",
          explanation: "link product details"
        },
        {
          filePath: "styles.css",
          originalContent: "",
          modifiedContent: ".product { display: grid; }\n",
          explanation: "style product details"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [
          { path: "index.html", reason: "link product detail URLs" },
          { path: "styles.css", reason: "style the product detail layout" }
        ],
        implementationChecklist: [
          "Read the product slug from the URL and render the matching record using safe DOM APIs."
        ]
      }
    );

    expect(errors.join("\n")).toContain("[missing-frontend-layer:javascript]");
    expect(errors.join("\n")).toContain("explicit in the implementation checklist");
  });

  it("rejects a UI-only patch when the request explicitly requires backing server behavior", () => {
    const plan = {
      ...basePlan,
      requiredFiles: [
        { path: "src/settings-form.tsx", reason: "add the settings form UI and submit action" },
        { path: "src/settings-service.ts", reason: "persist settings in the backing server service" }
      ],
      acceptanceCriteria: ["The settings form persists preferences through the server-side service."]
    };
    const frontendChange = {
      filePath: "src/settings-form.tsx",
      originalContent: "export function SettingsForm() { return null; }\n",
      modifiedContent: "export function SettingsForm() { return <button>Save</button>; }\n",
      explanation: "add the save interaction"
    };

    const errors = validatePlanCompletion(
      [frontendChange],
      plan,
      "Add a settings form that persists preferences through the server-side service."
    );

    expect(errors).toContain(
      "Implementation plan requires runtime/source changes for the backing server/handler/service surface of this full-stack UI request: src/settings-service.ts"
    );
  });

  it("accepts both planned surfaces for an explicit full-stack UI request", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "src/settings-form.tsx",
          originalContent: "export function SettingsForm() { return null; }\n",
          modifiedContent: "export function SettingsForm() { return <button>Save</button>; }\n",
          explanation: "add the save interaction"
        },
        {
          filePath: "src/settings-service.ts",
          originalContent: "export function saveSettings() {}\n",
          modifiedContent: "export function saveSettings(value: string) { return repository.save(value); }\n",
          explanation: "persist the submitted settings"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [
          { path: "src/settings-form.tsx", reason: "add the settings form UI and submit action" },
          { path: "src/settings-service.ts", reason: "persist settings in the backing server service" }
        ],
        acceptanceCriteria: ["The settings form persists preferences through the server-side service."]
      },
      "Add a settings form that persists preferences through the server-side service."
    );

    expect(errors.filter((error) => error.includes("full-stack UI request"))).toEqual([]);
  });

  it("does not invent a backend requirement for a client-only interaction", () => {
    const errors = validatePlanCompletion(
      [{
        filePath: "src/theme-toggle.tsx",
        originalContent: "export function ThemeToggle() { return null; }\n",
        modifiedContent: "export function ThemeToggle() { return <button>Theme</button>; }\n",
        explanation: "add a local theme toggle"
      }],
      {
        ...basePlan,
        requiredFiles: [{ path: "src/theme-toggle.tsx", reason: "add the client-only theme button" }],
        acceptanceCriteria: ["Clicking the button toggles the local theme state."]
      },
      "Add a client-only theme toggle button."
    );

    expect(errors.some((error) => /backing server|full-stack UI/.test(error))).toBe(false);
  });

  it("does not combine unrelated UI and API requirements into a full-stack contract", () => {
    const errors = validatePlanCompletion(
      [{
        filePath: "src/settings-page.tsx",
        originalContent: "export function SettingsPage() { return null; }\n",
        modifiedContent: "export function SettingsPage() { return <p>Settings</p>; }\n",
        explanation: "add the settings page copy"
      }],
      {
        ...basePlan,
        requiredFiles: [{ path: "src/settings-page.tsx", reason: "add the client settings page" }],
        acceptanceCriteria: ["The settings page shows the account label."]
      },
      "Add the client settings page.\nDocument the existing API separately."
    );

    expect(errors.some((error) => /backing server|full-stack UI/.test(error))).toBe(false);
  });

  it("does not treat a link to API documentation as backing application behavior", () => {
    const errors = validatePlanCompletion(
      [{
        filePath: "src/help-page.tsx",
        originalContent: "export function HelpPage() { return null; }\n",
        modifiedContent: "export function HelpPage() { return <a href='/docs'>API docs</a>; }\n",
        explanation: "link the API documentation"
      }],
      {
        ...basePlan,
        requiredFiles: [{ path: "src/help-page.tsx", reason: "add a button linking to API documentation" }],
        acceptanceCriteria: ["The help page includes a button that opens the API documentation."]
      },
      "Add a help-page button that opens the existing API documentation."
    );

    expect(errors.some((error) => /backing server|full-stack UI/.test(error))).toBe(false);
  });

  it("uses original feedback text to validate idempotency when the plan is underspecified", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "mosaic_demo/service.py",
          originalContent: "insert_request(source, external_ref)\n",
          modifiedContent: "insert_request(source, external_ref)\n",
          explanation: "touch request creation"
        }
      ],
      {
        ...basePlan,
        acceptanceCriteria: ["Request intake should handle the reported retry scenario."],
        verificationChecklist: ["Run the reported regression test."]
      },
      "Slack retries with the same source and external_ref should update the existing request instead of creating a duplicate."
    );

    expect(errors.join("\n")).toContain("idempotent duplicate/retry update path");
  });

  it("does not count unrelated lookup and update helpers as an idempotent update path", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "mosaic_demo/service.py",
          originalContent: "",
          modifiedContent: `
def get_or_create_requester(conn, email):
    existing = conn.execute("SELECT id FROM requesters WHERE email = ?", (email,)).fetchone()
    if existing:
        return existing["id"]
    return conn.execute("INSERT INTO requesters (email) VALUES (?)", (email,)).lastrowid

def create_request(conn, source, external_ref):
    return conn.execute("INSERT INTO service_requests (source, external_ref) VALUES (?, ?)", (source, external_ref)).lastrowid

def close_request(conn, request_id):
    conn.execute("UPDATE service_requests SET status = 'closed' WHERE id = ?", (request_id,))
`,
          explanation: "insert request"
        }
      ],
      {
        ...basePlan,
        acceptanceCriteria: ["Same source and external_ref updates the existing request instead of creating a duplicate."]
      }
    );

    expect(errors.join("\n")).toContain("idempotent duplicate/retry update path");
  });

  it("rejects generated tests that assert list fields not exposed by the implementation", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "mosaic_demo/service.py",
          originalContent: "",
          modifiedContent: `
def list_requests(conn):
    rows = conn.execute("""
        SELECT
            sr.id,
            sr.source,
            sr.title,
            sr.status
        FROM service_requests sr
    """).fetchall()
    return [row_to_dict(row) for row in rows]
`,
          explanation: "list requests"
        },
        {
          filePath: "tests/reported/test_requests.py",
          originalContent: "",
          modifiedContent: `
def test_list_body(conn):
    items = list_requests(conn)
    assert items[0]["body"] == "updated"
`,
          explanation: "assert body"
        }
      ],
      {
        ...basePlan,
        acceptanceCriteria: ["Request retries update the existing request."],
        verificationChecklist: ["Add a test for the retry behavior."]
      }
    );

    expect(errors.join("\n")).toContain("asserts field \"body\" on list_requests result");
  });

  it("requires implementation changes to route endpoint paths named in feedback", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "mosaic_demo/service.py",
          originalContent: "",
          modifiedContent: "def queue_metrics(conn):\n    return {\"open_by_priority\": {}}\n",
          explanation: "add metrics helper"
        },
        {
          filePath: "tests/reported/test_metrics.py",
          originalContent: "",
          modifiedContent: "def test_metrics_route():\n    assert call_get('/metrics')[0] == 200\n",
          explanation: "add route test"
        }
      ],
      {
        ...basePlan,
        acceptanceCriteria: ["Expose a dashboard endpoint."]
      },
      "The support lead wants GET /metrics with open request counts."
    );

    expect(errors.join("\n")).toContain("endpoint path /metrics");
  });

  it("does not require an unchanged existing route mentioned only by the plan", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "mosaic_demo/service.py",
          originalContent: 'order_by = "sr.created_at ASC"\n',
          modifiedContent: 'order_by = "sr.sla_due_at ASC, sr.created_at ASC"\n',
          explanation: "fix SLA ordering behind the existing requests route"
        },
        {
          filePath: "tests/generated/test_sla_sort.py",
          originalContent: "",
          modifiedContent: "def test_sla_sort(): assert True\n",
          explanation: "cover the corrected ordering"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [
          { path: "mosaic_demo/service.py", reason: "fix list_requests ordering" },
          { path: "tests/generated/test_sla_sort.py", reason: "add regression coverage" }
        ],
        acceptanceCriteria: [
          "GET /requests?sort=sla must use sla_due_at ASC, then created_at ASC"
        ],
        verificationChecklist: ["Add a unittest covering the SLA tie-breaker."]
      },
      "The support queue should show the next SLA breach first when sort=sla."
    );

    expect(errors).toEqual([]);
  });

  it("does not mistake product specifications for requested test specs", () => {
    const errors = validatePlanCompletion(
      [
        {
          filePath: "index.html",
          originalContent: "<main></main>\n",
          modifiedContent: '<main><dialog id="productModal"><dl class="product-specs"></dl></dialog></main>\n',
          explanation: "add product details markup"
        },
        {
          filePath: "script.js",
          originalContent: "",
          modifiedContent: "const productData = { vase: { specs: ['Stoneware'] } };\n",
          explanation: "populate product details"
        }
      ],
      {
        ...basePlan,
        requiredFiles: [
          { path: "index.html", reason: "add product modal" },
          { path: "script.js", reason: "add product data" }
        ],
        acceptanceCriteria: ["Product modal shows details and specifications while preserving filter behavior."],
        implementationChecklist: ["Add a product specs list with label/value rows."],
        verificationChecklist: ["Click each product and confirm its specs render."]
      }
    );

    expect(errors).not.toContain(
      "Implementation plan requires behavioral test coverage, but the generated change does not modify any test/spec file"
    );
  });
});

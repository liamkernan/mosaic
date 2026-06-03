import { describe, expect, it } from "vitest";

import { pruneChangesToPlanScope, validatePlanCompletion } from "../packages/pipeline/src/plan-completion-validator.js";

const basePlan = {
  requiredFiles: [],
  acceptanceCriteria: [],
  implementationChecklist: [],
  verificationChecklist: [],
  verificationCommands: []
};

describe("validatePlanCompletion", () => {
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
});

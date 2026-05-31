import { describe, expect, it } from "vitest";

import { validatePlanCompletion } from "../packages/pipeline/src/plan-completion-validator.js";

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
});

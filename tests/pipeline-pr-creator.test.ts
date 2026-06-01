import { describe, expect, it } from "vitest";

import type { PRPayload } from "../packages/core/src/index.js";
import { createPrBody } from "../packages/pipeline/src/pr-creator.js";

describe("PR creator", () => {
  it("links the generated PR footer to the real Mosaic repository", () => {
    const body = createPrBody(
      {
        repoFullName: "owner/repo",
        branchName: "mosaic/fix-copy-01TEST",
        title: "[Mosaic] Fix copy",
        body: "",
        feedbackItem: {
          id: "01TEST",
          source: "web_form",
          rawContent: "Fix copy",
          senderIdentifier: "user@example.com",
          repoFullName: "owner/repo",
          receivedAt: new Date("2026-01-01T00:00:00.000Z"),
          metadata: {},
          category: "copy_change",
          complexity: "trivial",
          summary: "Fix copy",
          relevantFiles: ["index.html"],
          confidence: 0.92
        },
        changes: [
          {
            filePath: "index.html",
            originalContent: "Old",
            modifiedContent: "New",
            explanation: "Update copy"
          }
        ]
      } satisfies PRPayload,
      {}
    );

    expect(body).toContain("https://github.com/liamkernan/mosaic");
    expect(body).not.toContain("YOUR_USERNAME/mosaic");
  });
});

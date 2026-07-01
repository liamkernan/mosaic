import { describe, expect, it } from "vitest";

import { normalize } from "../packages/intake/src/normalizer.js";

describe("normalize", () => {
  it("normalizes plain text without changing content", () => {
    const feedback = normalize(
      {
        rawContent: "  Please update the billing dashboard status copy.  ",
        repoFullName: "owner/repo",
        senderEmail: "user@example.com"
      },
      "email"
    );

    expect(feedback.rawContent).toBe("Please update the billing dashboard status copy.");
  });

  it("strips html and truncates content", () => {
    const oversizedContent = "x".repeat(5_100);
    const feedback = normalize(
      {
        rawContent: `<p>${oversizedContent}</p>`,
        repoFullName: "owner/repo",
        senderEmail: "user@example.com"
      },
      "email"
    );

    expect(feedback.rawContent).toBe("x".repeat(5_000));
    expect(feedback.rawContent).toHaveLength(5_000);
    expect(feedback.repoFullName).toBe("owner/repo");
  });

  it("extracts repo from subject tag", () => {
    const feedback = normalize(
      {
        subject: "[repo:owner/repo] Fix typo",
        rawContent: "Fix typo in footer"
      },
      "email"
    );

    expect(feedback.repoFullName).toBe("owner/repo");
  });
});

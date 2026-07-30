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
    expect(feedback.contentTruncation).toEqual({
      originalLength: 5_100,
      retainedLength: 5_000
    });
    expect(feedback.repoFullName).toBe("owner/repo");
  });

  it("does not mark content at the intake limit as truncated", () => {
    const feedback = normalize(
      {
        rawContent: "x".repeat(5_000),
        repoFullName: "owner/repo"
      },
      "api"
    );

    expect(feedback.rawContent).toHaveLength(5_000);
    expect(feedback.contentTruncation).toBeUndefined();
  });

  it("records truncation caused by email subject context and exposes hidden tail risk", () => {
    const body = `${"x".repeat(4_980)}\nPersist the API token in the database.`;
    const fullContent = `Subject: Account settings request\n\n${body}`;
    const feedback = normalize(
      {
        subject: "Account settings request",
        rawContent: body,
        repoFullName: "owner/repo"
      },
      "email"
    );

    expect(feedback.rawContent).toHaveLength(5_000);
    expect(feedback.rawContent).not.toContain("Persist the API token");
    expect(feedback.contentTruncation).toEqual({
      originalLength: fullContent.length,
      retainedLength: 5_000
    });
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

  it("preserves an email subject as model-visible classification context", () => {
    const body = [
      "The API trace viewer throws \"Unexpected end of JSON input\" for successful 204",
      "responses when the upstream service retains an application/json content type.",
      "The Response tab then hides useful headers and timing context.",
      "",
      "Please treat 204 and 205 responses, and otherwise empty bodies, as no-content",
      "before JSON parsing. Valid non-empty JSON should keep its current formatting.",
      "Please add regression coverage for the empty-response cases."
    ].join("\n");
    const feedback = normalize(
      {
        subject: "Trace viewer crashes on empty 204 JSON responses",
        rawContent: body,
        repoFullName: "owner/pulseboard"
      },
      "email"
    );

    expect(feedback.rawContent).toBe(
      `Subject: Trace viewer crashes on empty 204 JSON responses\n\n${body}`
    );
  });

  it("does not duplicate a subject that already begins the email body", () => {
    const feedback = normalize(
      {
        subject: "Trace viewer crashes",
        rawContent: "Trace viewer crashes on empty responses.",
        repoFullName: "owner/pulseboard"
      },
      "email"
    );

    expect(feedback.rawContent).toBe("Trace viewer crashes on empty responses.");
  });
});

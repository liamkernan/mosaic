import { describe, expect, it } from "vitest";

import { parseFeedbackEmail } from "../packages/intake/src/adapters/email.adapter.js";

describe("email adapter", () => {
  it("parses encoded headers and multipart MIME bodies", async () => {
    const rawEmail = [
      "From: =?UTF-8?Q?Jos=C3=A9_User?= <jose@example.com>",
      "Subject: =?UTF-8?B?W3JlcG86b3duZXIvcmVwb10gQ2Fmw6kgZmVlZGJhY2s=?=",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="mosaic-boundary"',
      "",
      "--mosaic-boundary",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Please fix the caf=C3=A9 heading.",
      "",
      "--mosaic-boundary",
      'Content-Type: text/html; charset="UTF-8"',
      "",
      "<p>Please fix the <strong>caf&eacute;</strong> heading.</p>",
      "--mosaic-boundary--",
      ""
    ].join("\r\n");

    const parsed = await parseFeedbackEmail(rawEmail);

    expect(parsed.subject).toBe("[repo:owner/repo] Café feedback");
    expect(parsed.from).toBe('"José User" <jose@example.com>');
    expect(parsed.repoFullName).toBe("owner/repo");
    expect(parsed.body).toBe("Please fix the café heading.");
  });
});

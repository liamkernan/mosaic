import { describe, expect, it } from "vitest";

import { getConfiguredEmailMailboxes, parseFeedbackEmail } from "../packages/intake/src/adapters/email.adapter.js";

describe("email adapter", () => {
  it("parses encoded headers and multipart MIME bodies", async () => {
    const rawEmail = [
      "From: =?UTF-8?Q?Jos=C3=A9_User?= <jose@example.com>",
      "Subject: =?UTF-8?B?Q2Fmw6kgZmVlZGJhY2s=?=",
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

    expect(parsed.subject).toBe("Café feedback");
    expect(parsed.from).toBe('"José User" <jose@example.com>');
    expect(parsed.body).toBe("Please fix the café heading.");
  });

  it("parses one configured mailbox per repo from EMAIL_MAILBOXES", () => {
    const mailboxes = getConfiguredEmailMailboxes({
      EMAIL_MAILBOXES: JSON.stringify([
        {
          repoFullName: "owner/project-a",
          host: "imap.example.com",
          user: "project-a-support@example.com",
          pass: "app-password-a"
        },
        {
          repoFullName: "owner/project-b",
          host: "imap.example.com",
          port: 1993,
          user: "project-b-support@example.com",
          pass: "app-password-b",
          address: "support-project-b@example.com",
          mailbox: "Feedback",
          secure: true
        }
      ])
    });

    expect(mailboxes).toEqual([
      {
        repoFullName: "owner/project-a",
        host: "imap.example.com",
        port: 993,
        user: "project-a-support@example.com",
        pass: "app-password-a",
        address: "project-a-support@example.com",
        mailbox: "INBOX",
        secure: true
      },
      {
        repoFullName: "owner/project-b",
        host: "imap.example.com",
        port: 1993,
        user: "project-b-support@example.com",
        pass: "app-password-b",
        address: "support-project-b@example.com",
        mailbox: "Feedback",
        secure: true
      }
    ]);
  });

  it("requires a repo mapping for single-mailbox email intake", () => {
    expect(() =>
      getConfiguredEmailMailboxes({
        EMAIL_IMAP_HOST: "imap.example.com",
        EMAIL_IMAP_PORT: 993,
        EMAIL_IMAP_USER: "support@example.com",
        EMAIL_IMAP_PASS: "app-password"
      })
    ).toThrow("EMAIL_IMAP_HOST, EMAIL_IMAP_USER, EMAIL_IMAP_PASS, and EMAIL_REPO_FULL_NAME are required");
  });

  it("supports a single local mailbox mapped to one repo", () => {
    const mailboxes = getConfiguredEmailMailboxes({
      EMAIL_IMAP_HOST: "imap.example.com",
      EMAIL_IMAP_PORT: 993,
      EMAIL_IMAP_USER: "project-a-support@example.com",
      EMAIL_IMAP_PASS: "app-password",
      EMAIL_IMAP_MAILBOX: "Feedback",
      EMAIL_REPO_FULL_NAME: "owner/project-a"
    });

    expect(mailboxes).toEqual([
      {
        repoFullName: "owner/project-a",
        host: "imap.example.com",
        port: 993,
        user: "project-a-support@example.com",
        pass: "app-password",
        address: "project-a-support@example.com",
        mailbox: "Feedback",
        secure: true
      }
    ]);
  });
});

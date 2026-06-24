import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertEmbedBotFields,
  assertEmbedOriginAllowed,
  buildAnonymousSenderIdentifier,
  findFormEmbedConfig,
  parseFormEmbedConfigs,
  renderEmbedScript
} from "../packages/intake/src/form-embeds.js";
import { createIntakeServer } from "../packages/intake/src/server.js";
import { enqueueFeedback } from "../packages/intake/src/queue.js";

vi.mock("../packages/intake/src/queue.js", () => ({
  enqueueFeedback: vi.fn()
}));

describe("form embeds", () => {
  const originalFormEmbeds = process.env.MOSAIC_FORM_EMBEDS;

  afterEach(() => {
    if (originalFormEmbeds === undefined) {
      delete process.env.MOSAIC_FORM_EMBEDS;
    } else {
      process.env.MOSAIC_FORM_EMBEDS = originalFormEmbeds;
    }

    vi.clearAllMocks();
  });

  it("parses embeddable form config", () => {
    const configs = parseFormEmbedConfigs(JSON.stringify([
      {
        embedKey: "acme-site",
        repoFullName: "owner/repo",
        allowedOrigins: ["https://example.com/contact"],
        displayName: "Send product feedback",
        requireEmail: true,
        minSubmitMs: 800
      }
    ]));

    expect(configs).toEqual([
      {
        embedKey: "acme-site",
        repoFullName: "owner/repo",
        allowedOrigins: ["https://example.com"],
        displayName: "Send product feedback",
        requireEmail: true,
        minSubmitMs: 800
      }
    ]);
  });

  it("refreshes cached embed configs when the environment changes", () => {
    process.env.MOSAIC_FORM_EMBEDS = JSON.stringify([
      { embedKey: "site-one", repoFullName: "owner/one", allowedOrigins: ["https://one.example.com"] }
    ]);
    expect(findFormEmbedConfig("site-one").repoFullName).toBe("owner/one");

    process.env.MOSAIC_FORM_EMBEDS = JSON.stringify([
      { embedKey: "site-one", repoFullName: "owner/two", allowedOrigins: ["https://two.example.com"] }
    ]);

    expect(findFormEmbedConfig("site-one").repoFullName).toBe("owner/two");
  });

  it("does not expose cached embed config objects for mutation", () => {
    process.env.MOSAIC_FORM_EMBEDS = JSON.stringify([
      { embedKey: "site-one", repoFullName: "owner/one", allowedOrigins: ["https://one.example.com"] }
    ]);

    const config = findFormEmbedConfig("site-one");
    config.allowedOrigins.push("https://mutated.example.com");

    expect(findFormEmbedConfig("site-one").allowedOrigins).toEqual(["https://one.example.com"]);
  });

  it("requires unique embed keys and valid repo mappings", () => {
    expect(() => parseFormEmbedConfigs(JSON.stringify([
      { embedKey: "bad key", repoFullName: "owner/repo", allowedOrigins: ["https://example.com"] }
    ]))).toThrow();

    expect(() => parseFormEmbedConfigs(JSON.stringify([
      { embedKey: "site-one", repoFullName: "not a repo", allowedOrigins: ["https://example.com"] }
    ]))).toThrow();

    expect(() => parseFormEmbedConfigs(JSON.stringify([
      { embedKey: "site-one", repoFullName: "owner/repo", allowedOrigins: ["https://example.com"] },
      { embedKey: "site-one", repoFullName: "owner/other", allowedOrigins: ["https://example.org"] }
    ]))).toThrow();
  });

  it("enforces configured origins", () => {
    const [config] = parseFormEmbedConfigs(JSON.stringify([
      { embedKey: "site-one", repoFullName: "owner/repo", allowedOrigins: ["https://example.com"] }
    ]));

    expect(() => assertEmbedOriginAllowed("https://example.com", config)).not.toThrow();
    expect(() => assertEmbedOriginAllowed("https://evil.example", config)).toThrow("origin is not allowed");
    expect(() => assertEmbedOriginAllowed(undefined, config)).toThrow("origin is not allowed");
  });

  it("uses lightweight bot protection fields", () => {
    const now = 1_000_000;

    expect(() => assertEmbedBotFields({ honeypot: "", loadedAt: now - 2_000 }, now, 1_200)).not.toThrow();
    expect(() => assertEmbedBotFields({ honeypot: "company", loadedAt: now - 2_000 }, now, 1_200)).toThrow("bot protection");
    expect(() => assertEmbedBotFields({ honeypot: "", loadedAt: now - 500 }, now, 1_200)).toThrow("too quickly");
    expect(() => assertEmbedBotFields({ honeypot: "" }, now, 1_200)).toThrow("missing bot protection");
  });

  it("does not use one shared anonymous sender for every site visitor", () => {
    expect(buildAnonymousSenderIdentifier("site-one", "203.0.113.10"))
      .not.toBe(buildAnonymousSenderIdentifier("site-one", "203.0.113.11"));
  });

  it("renders a drop-in widget script for the embed key", () => {
    const [config] = parseFormEmbedConfigs(JSON.stringify([
      {
        embedKey: "site-one",
        repoFullName: "owner/repo",
        allowedOrigins: ["https://example.com"],
        displayName: "Contact us"
      }
    ]));

    const script = renderEmbedScript(config);

    expect(script).toContain('"embedKey":"site-one"');
    expect(script).toContain('"displayName":"Contact us"');
    expect(script).toContain("/webhook/form/embed");
    expect(script).toContain("mosaic-feedback-hp");
    expect(() => new Function(script)).not.toThrow();
  });

  it("routes embedded submissions by server-side embed config", async () => {
    process.env.MOSAIC_FORM_EMBEDS = JSON.stringify([
      {
        embedKey: "site-one",
        repoFullName: "owner/repo",
        allowedOrigins: ["https://example.com"],
        displayName: "Contact us"
      }
    ]);

    const { server } = await createIntakeServer();
    const response = await server.inject({
      method: "POST",
      url: "/webhook/form/embed",
      headers: { origin: "https://example.com" },
      payload: {
        embedKey: "site-one",
        message: "Fix the confusing copy on the staff page.",
        loadedAt: Date.now() - 2_000,
        pageUrl: "https://example.com/contact"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(enqueueFeedback).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFeedback).mock.calls[0]?.[0]).toMatchObject({
      source: "web_form",
      repoFullName: "owner/repo",
      rawContent: "Fix the confusing copy on the staff page.",
      metadata: {
        origin: "https://example.com",
        pageUrl: "https://example.com/contact",
        embedKey: "site-one"
      }
    });

    await server.close();
  });
});

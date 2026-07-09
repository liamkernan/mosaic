import { describe, expect, it } from "vitest";

import { runDemo } from "../scripts/demo.js";

describe("offline demo", () => {
  it("shows a validated PR candidate and an in-memory quarantine outcome without external services", async () => {
    const output: string[] = [];

    const result = await runDemo((line) => output.push(line));

    expect(result.safe.validation).toEqual({ valid: true, errors: [] });
    expect(result.safe.planValidationErrors).toEqual([]);
    expect(result.safe.disposition.disposition).toBe("pr");
    expect(result.safe.changes).toEqual([expect.objectContaining({ filePath: "src/hero.ts" })]);
    expect(result.safe.changes[0]?.modifiedContent).toContain(
      'export const heroHeadline = "Turn feedback into product improvements.";'
    );
    expect(result.unsafe.assessment).toEqual(expect.objectContaining({ accepted: false }));
    expect(result.unsafe.reason).toContain("ignore (all )?previous instructions");
    expect(result.unsafe.quarantineKey).toBe("feedback-quarantine:demo/mosaic");
    expect(output.join("\n")).toContain("SAFE FEEDBACK -> PR CANDIDATE");
    expect(output.join("\n")).toContain("UNSAFE FEEDBACK -> QUARANTINE");
    expect(output.join("\n")).toContain("No API keys, Redis server, GitHub App, or network calls are used.");
  });
});

import { describe, expect, it } from "vitest";

import { parseGeneratedChanges } from "../packages/pipeline/src/generated-change-parser.js";

describe("generated change parser", () => {
  it("parses direct json arrays", () => {
    const parsed = parseGeneratedChanges(
      '[{"filePath":"styles.css","modifiedContent":"body {}","explanation":"Fix alignment."}]'
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.filePath).toBe("styles.css");
  });

  it("extracts json arrays from fenced code blocks", () => {
    const parsed = parseGeneratedChanges(
      '```json\n[{"filePath":"styles.css","modifiedContent":"body {}","explanation":"Fix alignment."}]\n```'
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.explanation).toBe("Fix alignment.");
  });
});

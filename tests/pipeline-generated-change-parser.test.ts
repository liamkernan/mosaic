import { describe, expect, it } from "vitest";

import { parseGeneratedChanges } from "../packages/pipeline/src/generated-change-parser.js";

describe("generated change parser", () => {
  it("parses tagged change payloads with raw file content", () => {
    const parsed = parseGeneratedChanges(`
<changes>
  <change>
    <filePath>styles.css</filePath>
    <modifiedContent><![CDATA[
body {
  color: red;
}
]]></modifiedContent>
    <explanation>Fix alignment.</explanation>
  </change>
</changes>`);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.filePath).toBe("styles.css");
    expect(parsed[0]?.modifiedContent).toContain("color: red;");
  });

  it("parses direct json arrays", () => {
    const parsed = parseGeneratedChanges(
      '[{"filePath":"styles.css","modifiedContent":"body {}","explanation":"Fix alignment."}]'
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.filePath).toBe("styles.css");
  });

  it("parses tagged search replace edits", () => {
    const parsed = parseGeneratedChanges(`
<changes>
  <edit>
    <filePath>index.html</filePath>
    <search><![CDATA[
<main></main>
]]></search>
    <replace><![CDATA[
<main><button type="button">Open</button></main>
]]></replace>
    <explanation>Add a real modal trigger.</explanation>
  </edit>
</changes>`);

    expect(parsed).toEqual([
      {
        filePath: "index.html",
        search: "<main></main>",
        replace: '<main><button type="button">Open</button></main>',
        explanation: "Add a real modal trigger."
      }
    ]);
  });

  it("extracts json arrays from fenced code blocks", () => {
    const parsed = parseGeneratedChanges(
      '```json\n[{"filePath":"styles.css","modifiedContent":"body {}","explanation":"Fix alignment."}]\n```'
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.explanation).toBe("Fix alignment.");
  });
});

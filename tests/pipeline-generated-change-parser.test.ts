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

  it.each([
    ["directly", '[{"filePath":"styles.css","modifiedContent":"body {}","explanation":"Fix alignment."}]'],
    ["with leading whitespace", '\n  [{"filePath":"styles.css","modifiedContent":"body {}","explanation":"Fix alignment."}]']
  ])("parses json arrays %s", (_format, payload) => {
    const parsed = parseGeneratedChanges(payload);

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

  it("accepts the explicit empty changes payload as a safe no-op", () => {
    expect(parseGeneratedChanges("<changes>\n\n</changes>")).toEqual([]);
  });

  it("preserves mixed change and edit operations in response order", () => {
    const parsed = parseGeneratedChanges(`<changes>
  <edit>
    <filePath>index.html</filePath>
    <search><![CDATA[<head></head>]]></search>
    <replace><![CDATA[<head><link rel="stylesheet" href="./modal.css" /></head>]]></replace>
    <explanation>Link styles first.</explanation>
  </edit>
  <change>
    <filePath>modal.css</filePath>
    <modifiedContent><![CDATA[dialog { display: block; }]]></modifiedContent>
    <explanation>Add modal styles second.</explanation>
  </change>
  <edit>
    <filePath>index.html</filePath>
    <search><![CDATA[<main></main>]]></search>
    <replace><![CDATA[<main><dialog></dialog></main>]]></replace>
    <explanation>Add markup third.</explanation>
  </edit>
</changes>`);

    expect(parsed.map(({ filePath, explanation }) => ({ filePath, explanation }))).toEqual([
      { filePath: "index.html", explanation: "Link styles first." },
      { filePath: "modal.css", explanation: "Add modal styles second." },
      { filePath: "index.html", explanation: "Add markup third." }
    ]);
  });

  it("extracts json arrays from fenced code blocks", () => {
    const parsed = parseGeneratedChanges(
      '```json\n[{"filePath":"styles.css","modifiedContent":"body {}","explanation":"Fix alignment."}]\n```'
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.explanation).toBe("Fix alignment.");
  });

  it("decodes xml entities in tagged metadata", () => {
    const parsed = parseGeneratedChanges(`
<changes>
  <change>
    <filePath>src/routes/users&amp;teams.ts</filePath>
    <modifiedContent><![CDATA[
export const value = true;
]]></modifiedContent>
    <explanation>Handle &lt;users&gt; &amp; teams.</explanation>
  </change>
</changes>`);

    expect(parsed[0]?.filePath).toBe("src/routes/users&teams.ts");
    expect(parsed[0]?.explanation).toBe("Handle <users> & teams.");
  });
});

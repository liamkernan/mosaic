import { describe, expect, it } from "vitest";

import { mergeGeneratedChanges } from "../packages/pipeline/src/change-set.js";
import { buildGeneratedChange } from "./helpers/pipeline.js";

describe("mergeGeneratedChanges", () => {
  it("overlays focused repair changes without dropping untouched files", () => {
    const merged = mergeGeneratedChanges(
      [
        buildGeneratedChange({
          filePath: "src/service.py",
          originalContent: "old service\n",
          modifiedContent: "new service\n",
          explanation: "fix behavior"
        }),
        buildGeneratedChange({
          filePath: "tests/test_service.py",
          originalContent: "old test\n",
          modifiedContent: "bad test\n",
          explanation: "add coverage"
        })
      ],
      [
        buildGeneratedChange({
          filePath: "tests/test_service.py",
          originalContent: "old test\n",
          modifiedContent: "fixed test\n",
          explanation: "repair assertion"
        })
      ]
    );

    expect(merged.map((change) => change.filePath)).toEqual(["src/service.py", "tests/test_service.py"]);
    expect(merged[0].modifiedContent).toBe("new service\n");
    expect(merged[1].modifiedContent).toBe("fixed test\n");
  });
});

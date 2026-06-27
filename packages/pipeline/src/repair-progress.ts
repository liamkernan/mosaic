import type { GeneratedChange } from "@mosaic/core";

export type RepairTrend = "reduced" | "preserved" | "increased";

export interface RepairProgressAssessment {
  accepted: boolean;
  trend: RepairTrend;
  addedFiles: string[];
  introducedCategories: string[];
}

const errorCategoryPatterns: Array<[string, RegExp]> = [
  ["scope", /outside the implementation plan scope|unrelated protected symbol/i],
  ["syntax", /syntax validation failed|invalid syntax|parser error/i],
  ["accessibility", /non-interactive container|keyboard activation|accessible role|tabindex|inert link/i],
  ["modal-behavior", /modal UI hooks without complete|missing interactive behavior|matching behavior/i],
  ["modal-style", /modal UI hooks.*stylesheet|matching selectors in changed stylesheets/i],
  ["test-integrity", /weakens existing test|test integrity|trivial truth/i],
  ["test-coverage", /behavioral test|test coverage|test file/i],
  ["endpoint", /endpoint route|requested HTTP path|falling through to not found/i],
  ["runtime-source", /runtime\/source changes|actual application source/i],
  ["security", /requires review|secret|credential|unsafe|security/i],
  ["verification", /verification failed|verification command failed|unittest verification failed/i],
  ["frontend-assertion", /frontend assertion|click target not found|expected element not found|expected at least/i]
];

export function repairErrorCategory(error: string): string {
  for (const [category, pattern] of errorCategoryPatterns) {
    if (pattern.test(error)) {
      return category;
    }
  }

  return error
    .split(/[:;(]/, 1)[0]
    .toLowerCase()
    .replace(/\b(?:[a-z0-9_-]+\/)+[a-z0-9_.-]+\b/gi, "<path>")
    .replace(/\d+/g, "#")
    .trim();
}

function errorCategories(errors: string[]): Set<string> {
  return new Set(errors.map(repairErrorCategory));
}

export function assessRepairProgress(
  currentChanges: GeneratedChange[],
  candidateChanges: GeneratedChange[],
  beforeErrors: string[],
  afterErrors: string[]
): RepairProgressAssessment {
  const currentPaths = new Set(currentChanges.map((change) => change.filePath));
  const addedFiles = candidateChanges
    .map((change) => change.filePath)
    .filter((filePath) => !currentPaths.has(filePath));
  const beforeCategories = errorCategories(beforeErrors);
  const introducedCategories = [...errorCategories(afterErrors)]
    .filter((category) => !beforeCategories.has(category))
    .sort();
  const increased = addedFiles.length > 0 ||
    introducedCategories.length > 0 ||
    afterErrors.length > beforeErrors.length;
  const trend: RepairTrend = increased
    ? "increased"
    : afterErrors.length < beforeErrors.length
      ? "reduced"
      : "preserved";

  return {
    accepted: !increased,
    trend,
    addedFiles,
    introducedCategories
  };
}

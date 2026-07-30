import type { GeneratedChange } from "@mosaic/core";

export type RepairTrend = "reduced" | "preserved" | "stalled" | "increased";

export interface RepairProgressAssessment {
  accepted: boolean;
  trend: RepairTrend;
  addedFiles: string[];
  unplannedAddedFiles: string[];
  removedFiles: string[];
  plannedRemovedFiles: string[];
  introducedCategories: string[];
}

export interface RepairProgressOptions {
  plannedFiles?: Iterable<string>;
}

const errorCategoryPatterns: Array<[string, RegExp]> = [
  ["scope", /outside the implementation plan scope|unrelated protected symbol/i],
  ["frontend-layer", /\[missing-frontend-layer:(?:html|javascript|css)\]/i],
  ["syntax", /syntax validation failed|invalid syntax|parser error/i],
  ["accessibility", /non-interactive container|keyboard activation|accessible role|tabindex|inert link/i],
  ["modal-behavior", /modal UI hooks without complete|missing interactive behavior|matching behavior/i],
  ["modal-style", /modal UI hooks.*stylesheet|matching selectors in changed stylesheets/i],
  ["test-integrity", /weakens existing test|test integrity|trivial truth/i],
  ["test-coverage", /behavioral test|test coverage|test file/i],
  ["endpoint", /endpoint route|requested HTTP path|falling through to not found/i],
  ["runtime-source", /runtime\/source changes|actual application source/i],
  ["security", /requires review|secret|credential|unsafe|security/i],
  ["verification", /verification failed|(?:verification )?command failed|unittest verification failed|Generated test (?:failed|did not execute) independently/i],
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

function hasSameErrors(left: string[], right: string[]): boolean {
  if (left.length === 0 || left.length !== right.length) {
    return false;
  }

  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((error, index) => error === sortedRight[index]);
}

function effectiveFilePaths(changes: GeneratedChange[]): string[] {
  return [...new Set(changes
    .filter((change) => change.originalContent !== change.modifiedContent)
    .map((change) => change.filePath))];
}

function addedFilePaths(currentChanges: GeneratedChange[], candidateChanges: GeneratedChange[]): string[] {
  const currentPaths = new Set(effectiveFilePaths(currentChanges));
  return effectiveFilePaths(candidateChanges)
    .filter((filePath) => !currentPaths.has(filePath));
}

function removedFilePaths(currentChanges: GeneratedChange[], candidateChanges: GeneratedChange[]): string[] {
  const candidatePaths = new Set(effectiveFilePaths(candidateChanges));
  return effectiveFilePaths(currentChanges)
    .filter((filePath) => !candidatePaths.has(filePath));
}

export function findUnplannedAddedFiles(
  currentChanges: GeneratedChange[],
  candidateChanges: GeneratedChange[],
  plannedFiles: Iterable<string> = []
): string[] {
  const plannedPaths = new Set(plannedFiles);
  return addedFilePaths(currentChanges, candidateChanges)
    .filter((filePath) => !plannedPaths.has(filePath));
}

export function assessRepairProgress(
  currentChanges: GeneratedChange[],
  candidateChanges: GeneratedChange[],
  beforeErrors: string[],
  afterErrors: string[],
  options: RepairProgressOptions = {}
): RepairProgressAssessment {
  const plannedFiles = [...(options.plannedFiles ?? [])];
  const plannedPaths = new Set(plannedFiles);
  const addedFiles = addedFilePaths(currentChanges, candidateChanges);
  const unplannedAddedFiles = findUnplannedAddedFiles(
    currentChanges,
    candidateChanges,
    plannedFiles
  );
  const removedFiles = removedFilePaths(currentChanges, candidateChanges);
  const plannedRemovedFiles = removedFiles.filter((filePath) => plannedPaths.has(filePath));
  const beforeCategories = errorCategories(beforeErrors);
  const introducedCategories = [...errorCategories(afterErrors)]
    .filter((category) => !beforeCategories.has(category))
    .sort();
  const plannedFilesWithoutProgress = addedFiles.length > 0 && afterErrors.length >= beforeErrors.length;
  const unchangedErrors = hasSameErrors(beforeErrors, afterErrors);
  const increased = removedFiles.length > 0 ||
    unplannedAddedFiles.length > 0 ||
    plannedFilesWithoutProgress ||
    introducedCategories.length > 0 ||
    afterErrors.length > beforeErrors.length;
  let trend: RepairTrend = "preserved";
  if (increased) {
    trend = "increased";
  } else if (unchangedErrors) {
    trend = "stalled";
  } else if (afterErrors.length < beforeErrors.length) {
    trend = "reduced";
  }

  return {
    accepted: !increased && !unchangedErrors,
    trend,
    addedFiles,
    unplannedAddedFiles,
    removedFiles,
    plannedRemovedFiles,
    introducedCategories
  };
}

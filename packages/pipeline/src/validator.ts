import { access } from "node:fs/promises";
import { join } from "node:path";

import { type GeneratedChange, type RepoContext } from "@feedbackbot/core";
import ts from "typescript";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ValidationLimits {
  maxLinesAdded?: number;
}

const unsafePatterns = ["eval(", "Function(", "child_process", "exec(", "execSync"];
const urlPattern = /\bhttps?:\/\/[^\s"'`]+/g;
const ipPattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

function countChangedLines(original: string, modified: string): number {
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");
  const maxLength = Math.max(originalLines.length, modifiedLines.length);
  let changed = 0;

  for (let index = 0; index < maxLength; index += 1) {
    if (originalLines[index] !== modifiedLines[index]) {
      changed += 1;
    }
  }

  return changed;
}

function countAddedLines(original: string, modified: string): number {
  const originalSet = new Set(original.split("\n"));
  return modified
    .split("\n")
    .filter((line) => line.trim().length > 0 && !originalSet.has(line)).length;
}

function findAddedMatches(pattern: RegExp, original: string, modified: string): string[] {
  const originalMatches = new Set(original.match(pattern) ?? []);
  return [...new Set(modified.match(pattern) ?? [])].filter((match) => !originalMatches.has(match));
}

function syntaxErrorsForFile(filePath: string, contents: string): string[] {
  if (!/\.(?:[cm]?[jt]sx?)$/i.test(filePath)) {
    return [];
  }

  const transpiled = ts.transpileModule(contents, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX
    },
    fileName: filePath,
    reportDiagnostics: true
  });

  return (transpiled.diagnostics ?? []).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

export async function validate(
  changes: GeneratedChange[],
  repoContext: RepoContext,
  limits: ValidationLimits = {}
): Promise<ValidationResult> {
  const errors: string[] = [];
  let totalLinesAdded = 0;

  for (const change of changes) {
    const absolutePath = join(repoContext.localPath, change.filePath);
    const fileExists = await access(absolutePath).then(
      () => true,
      () => false
    );

    if (!fileExists && change.originalContent.length > 0) {
      errors.push(`File ${change.filePath} was expected to exist but does not`);
    }

    const changedLines = countChangedLines(change.originalContent, change.modifiedContent);
    if (changedLines === 0) {
      continue;
    }
    if (changedLines > 500) {
      errors.push(`Change for ${change.filePath} is too large (${changedLines} changed lines)`);
    }

    const parseErrors = syntaxErrorsForFile(change.filePath, change.modifiedContent);
    if (parseErrors.length > 0) {
      errors.push(`Syntax validation failed for ${change.filePath}: ${parseErrors.join("; ")}`);
    }

    totalLinesAdded += countAddedLines(change.originalContent, change.modifiedContent);

    const addedUnsafePatterns = unsafePatterns.filter(
      (pattern) => change.modifiedContent.includes(pattern) && !change.originalContent.includes(pattern)
    );
    if (addedUnsafePatterns.length > 0) {
      errors.push(`Unsafe patterns added to ${change.filePath}: ${addedUnsafePatterns.join(", ")}`);
    }

    const newUrls = findAddedMatches(urlPattern, change.originalContent, change.modifiedContent);
    if (newUrls.length > 0) {
      errors.push(`New URL(s) added to ${change.filePath}: ${newUrls.join(", ")}`);
    }

    const newIps = findAddedMatches(ipPattern, change.originalContent, change.modifiedContent);
    if (newIps.length > 0) {
      errors.push(`New IP address(es) added to ${change.filePath}: ${newIps.join(", ")}`);
    }

    if (change.modifiedContent.includes("process.env") && !change.originalContent.includes("process.env")) {
      errors.push(`New process.env access added to ${change.filePath}`);
    }
  }

  const maxLinesAdded = limits.maxLinesAdded ?? 200;
  if (totalLinesAdded >= maxLinesAdded) {
    errors.push(`Total new code added exceeds limit: ${totalLinesAdded} lines`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

import type { GeneratedChange } from "@mosaic/core";

import type { ImplementationPlan } from "./implementation-planner.js";

const behavioralKeywords = /\b(?:sort|order|ordering|rank|ranking|filter|tie-?breaker|fallback|dedupe|idempotent|permission|validation|api|endpoint|status|state)\b/i;
const testPathPattern = /(?:^|\/)(?:test|tests|spec|specs|__tests__|reported)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const documentationPathPattern = /(?:^|\/)(?:readme|changelog|docs?|documentation)(?:\/|\.|$)|\.(?:md|mdx|rst|txt)$/i;
const sourcePathPattern = /\.(?:[cm]?[jt]sx?|tsx?|py|rb|go|rs|java|kt|php|cs|swift|vue|svelte)$/i;
const staticAssetPathPattern = /\.(?:html?|css|[cm]?js)$/i;
const companionConfigPathPattern = /(?:^|\/)(?:package\.json|pnpm-workspace\.ya?ml|tsconfig(?:\.[^.]+)?\.json|jsconfig(?:\.[^.]+)?\.json|vitest\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|pyproject\.toml|setup\.py|setup\.cfg|requirements(?:-[^.]+)?\.txt|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock)$/i;
const orderedClausePattern = /`([^`]*(?:ASC|DESC|ORDER BY)[^`]*)`/gi;
const idempotencyPlanPattern = /\b(?:dedupe|duplicate|idempotent|idempotency|retry|same source|external[_\s-]?ref(?:erence)?)\b/i;
const endpointPathPattern = /\b(?:GET|POST|PUT|PATCH|DELETE)\s+(`?)(\/[a-zA-Z0-9_./:-]+)\1/g;

function planText(plan: ImplementationPlan, sourceText = ""): string {
  return [
    sourceText,
    ...plan.acceptanceCriteria,
    ...plan.implementationChecklist,
    ...plan.verificationChecklist
  ].join("\n");
}

function changedTestFiles(changes: GeneratedChange[]): GeneratedChange[] {
  return changes.filter((change) => testPathPattern.test(change.filePath));
}

function changedRuntimeFiles(changes: GeneratedChange[]): GeneratedChange[] {
  return changes.filter((change) =>
    !testPathPattern.test(change.filePath) &&
    !documentationPathPattern.test(change.filePath)
  );
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\//, "").trim();
}

function dirname(path: string): string {
  const normalized = normalizeRepoPath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function basename(path: string): string {
  const normalized = normalizeRepoPath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function extension(path: string): string {
  const name = basename(path).toLowerCase();
  const match = name.match(/(\.[a-z0-9]+)$/);
  return match?.[1] ?? "";
}

function stem(path: string): string {
  return basename(path)
    .replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/i, "")
    .replace(/\.[^.]+$/i, "")
    .toLowerCase();
}

function isChildPath(parentDir: string, path: string): boolean {
  const normalizedParent = normalizeRepoPath(parentDir);
  const normalizedPath = normalizeRepoPath(path);
  return normalizedParent.length === 0
    ? !normalizedPath.includes("/")
    : normalizedPath.startsWith(`${normalizedParent}/`);
}

function isAncestorPath(ancestorDir: string, childPath: string): boolean {
  const normalizedAncestor = normalizeRepoPath(ancestorDir);
  const normalizedChild = normalizeRepoPath(childPath);
  if (normalizedAncestor.length === 0) {
    return true;
  }

  return normalizedChild === normalizedAncestor || normalizedChild.startsWith(`${normalizedAncestor}/`);
}

function tokensForPath(path: string): Set<string> {
  return new Set(
    normalizeRepoPath(path)
      .toLowerCase()
      .replace(/\.(?:test|spec)\b/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !["src", "lib", "app", "test", "tests", "spec", "specs"].includes(token))
  );
}

function sharesMeaningfulToken(leftPath: string, rightPath: string): boolean {
  const leftTokens = tokensForPath(leftPath);
  const rightTokens = tokensForPath(rightPath);

  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      return true;
    }
  }

  return false;
}

function isStaticAssetCompanion(changedPath: string, requiredPath: string): boolean {
  const requiredExtension = extension(requiredPath);
  const changedExtension = extension(changedPath);
  if (!staticAssetPathPattern.test(requiredPath) || !staticAssetPathPattern.test(changedPath)) {
    return false;
  }

  const requiredDir = dirname(requiredPath);
  const changedDir = dirname(changedPath);
  if (requiredExtension === ".html" || requiredExtension === ".htm") {
    return changedDir === requiredDir || isChildPath(requiredDir, changedPath);
  }

  if (changedExtension === ".html" || changedExtension === ".htm") {
    return requiredDir === changedDir || isChildPath(changedDir, requiredPath);
  }

  return requiredDir === changedDir && sharesMeaningfulToken(changedPath, requiredPath);
}

function isTestCompanion(changedPath: string, requiredPath: string): boolean {
  if (!testPathPattern.test(changedPath)) {
    return false;
  }

  const changedStem = stem(changedPath);
  const requiredStem = stem(requiredPath);
  return changedStem.includes(requiredStem) ||
    requiredStem.includes(changedStem) ||
    sharesMeaningfulToken(changedPath, requiredPath);
}

function isCompanionConfigForRequiredFile(changedPath: string, requiredPath: string): boolean {
  if (!companionConfigPathPattern.test(changedPath)) {
    return false;
  }

  return isAncestorPath(dirname(changedPath), requiredPath);
}

function isAllowedPlannedCompanionChange(change: GeneratedChange, requiredPath: string, plan: ImplementationPlan, sourceText: string): boolean {
  const changedPath = normalizeRepoPath(change.filePath);
  const normalizedRequiredPath = normalizeRepoPath(requiredPath);
  const sameDir = dirname(changedPath) === dirname(normalizedRequiredPath);

  if (sameDir && change.originalContent.length === 0 && (sourcePathPattern.test(changedPath) || testPathPattern.test(changedPath))) {
    return true;
  }

  if (isStaticAssetCompanion(changedPath, normalizedRequiredPath)) {
    return true;
  }

  if (isCompanionConfigForRequiredFile(changedPath, normalizedRequiredPath)) {
    return true;
  }

  if ((planRequiresBehavioralTests(plan, sourceText) || testPathPattern.test(normalizedRequiredPath)) && isTestCompanion(changedPath, normalizedRequiredPath)) {
    return true;
  }

  return false;
}

function validatePlannedChangeScope(changes: GeneratedChange[], plan: ImplementationPlan, sourceText = ""): string[] {
  const requiredPaths = [...new Set(plan.requiredFiles.map((file) => normalizeRepoPath(file.path)).filter(Boolean))];
  if (requiredPaths.length === 0) {
    return [];
  }

  if (!requiredPaths.some((path) => !testPathPattern.test(path) && !documentationPathPattern.test(path))) {
    return [];
  }

  const requiredPathSet = new Set(requiredPaths);
  const errors: string[] = [];

  for (const change of changes) {
    const changedPath = normalizeRepoPath(change.filePath);
    if (requiredPathSet.has(changedPath)) {
      continue;
    }

    if (requiredPaths.some((requiredPath) => isAllowedPlannedCompanionChange(change, requiredPath, plan, sourceText))) {
      continue;
    }

    errors.push(`Change for ${change.filePath} is outside the implementation plan scope. Planned files: ${requiredPaths.join(", ")}`);
  }

  return errors;
}

export function pruneChangesToPlanScope(changes: GeneratedChange[], plan: ImplementationPlan | undefined, sourceText = ""): GeneratedChange[] {
  if (!plan) {
    return changes;
  }

  return changes.filter((change) => validatePlannedChangeScope([change], plan, sourceText).length === 0);
}

function extractPythonListFunctionFields(content: string): Map<string, Set<string>> {
  const fieldsByFunction = new Map<string, Set<string>>();
  const functionPattern = /(?:^|\n)def\s+(list_[a-zA-Z0-9_]*)\s*\([^]*?(?=\ndef\s+|\nclass\s+|$)/g;
  let functionMatch: RegExpExecArray | null;

  while ((functionMatch = functionPattern.exec(content)) !== null) {
    const functionName = functionMatch[1];
    const block = functionMatch[0];
    const selectMatch = block.match(/\bSELECT\b([^]*?)\bFROM\b/i);
    if (!selectMatch) {
      continue;
    }

    const fields = new Set<string>();
    for (const fieldMatch of selectMatch[1].matchAll(/\b[a-z][a-z0-9_]*\.([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+AS\s+([a-zA-Z_][a-zA-Z0-9_]*))?/gi)) {
      fields.add((fieldMatch[2] ?? fieldMatch[1]).toLowerCase());
    }

    if (fields.size > 0) {
      fieldsByFunction.set(functionName, fields);
    }
  }

  return fieldsByFunction;
}

function generatedTestListFieldErrors(changes: GeneratedChange[]): string[] {
  const fieldsByFunction = new Map<string, Set<string>>();
  for (const change of changes.filter((item) => !testPathPattern.test(item.filePath))) {
    for (const [functionName, fields] of extractPythonListFunctionFields(change.modifiedContent)) {
      fieldsByFunction.set(functionName, fields);
    }
  }

  if (fieldsByFunction.size === 0) {
    return [];
  }

  const errors: string[] = [];
  for (const testChange of changedTestFiles(changes)) {
    for (const [functionName, availableFields] of fieldsByFunction) {
      const assignmentPattern = new RegExp(`\\b([a-zA-Z_][a-zA-Z0-9_]*)\\s*=\\s*${functionName}\\s*\\(`, "g");
      let assignmentMatch: RegExpExecArray | null;

      while ((assignmentMatch = assignmentPattern.exec(testChange.modifiedContent)) !== null) {
        const variableName = assignmentMatch[1];
        const fieldPattern = new RegExp(`\\b${variableName}\\s*\\[\\s*\\d+\\s*\\]\\s*\\[\\s*["']([^"']+)["']\\s*\\]`, "g");
        let fieldMatch: RegExpExecArray | null;

        while ((fieldMatch = fieldPattern.exec(testChange.modifiedContent)) !== null) {
          const fieldName = fieldMatch[1].toLowerCase();
          if (!availableFields.has(fieldName)) {
            errors.push(`Generated test asserts field "${fieldName}" on ${functionName} result, but no implementation change exposes that field on the list response`);
          }
        }
      }
    }
  }

  return errors;
}

function planRequiresBehavioralTests(plan: ImplementationPlan, sourceText = ""): boolean {
  const text = planText(plan, sourceText);
  const testChangePattern = /\b(?:add|update|create|write|extend|modify)\b.{0,80}\b(?:test|tests|spec|specs|coverage|unittest|pytest|jest|vitest)\b/i;
  const checklistRequestsTestChanges = [
    ...plan.implementationChecklist,
    ...plan.verificationChecklist
  ].some((item) => testChangePattern.test(item));
  const requiredTestFileChange = plan.requiredFiles.some((file) =>
    (testPathPattern.test(file.path) || /\b(?:test|tests|spec|coverage)\b/i.test(file.reason)) &&
    testChangePattern.test(file.reason)
  );

  return behavioralKeywords.test(text) && (checklistRequestsTestChanges || requiredTestFileChange);
}

function planRequiresRuntimeChange(plan: ImplementationPlan): boolean {
  return plan.requiredFiles.some((file) =>
    !testPathPattern.test(file.path) &&
    !documentationPathPattern.test(file.path)
  );
}

function orderedClauseTerms(clause: string): string[] {
  return clause
    .replace(/\bORDER\s+BY\b/gi, "")
    .replace(/\bthen\b/gi, ",")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/([a-zA-Z_][a-zA-Z0-9_.]*)\s+(ASC|DESC)\b/i);
      if (!match) {
        return "";
      }

      return `${match[1].split(".").pop()} ${match[2].toUpperCase()}`;
    })
    .filter(Boolean);
}

function extractOrderedClauses(plan: ImplementationPlan, sourceText = ""): string[][] {
  const clauses: string[][] = [];
  const text = planText(plan, sourceText);
  let match: RegExpExecArray | null;

  while ((match = orderedClausePattern.exec(text)) !== null) {
    const terms = orderedClauseTerms(match[1]);
    if (terms.length >= 2) {
      clauses.push(terms);
    }
  }

  for (const line of text.split("\n")) {
    const backtickedTerms = [...line.matchAll(/`([^`]+)`/g)]
      .flatMap((termMatch) => orderedClauseTerms(termMatch[1]));
    if (backtickedTerms.length >= 2) {
      clauses.push(backtickedTerms);
    }
  }

  return clauses;
}

function contentContainsTermsInOrder(content: string, terms: string[]): boolean {
  const compact = content.toLowerCase().replace(/\s+/g, " ");
  let cursor = 0;

  for (const term of terms) {
    const [field, direction] = term.toLowerCase().split(" ");
    const fieldIndex = compact.indexOf(field, cursor);
    if (fieldIndex < 0) {
      return false;
    }

    const directionIndex = compact.indexOf(direction, fieldIndex + field.length);
    if (directionIndex < 0 || directionIndex - fieldIndex > 80) {
      return false;
    }

    cursor = directionIndex + direction.length;
  }

  return true;
}

function extractEndpointPaths(plan: ImplementationPlan, sourceText = ""): string[] {
  const paths: string[] = [];
  const text = planText(plan, sourceText);
  let match: RegExpExecArray | null;

  while ((match = endpointPathPattern.exec(text)) !== null) {
    paths.push(match[2]);
  }

  return [...new Set(paths)];
}

function contentContainsEndpointPath(content: string, path: string): boolean {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`["'\`]${escapedPath}["'\`]`).test(content);
}

function planRequiresIdempotencyUpdate(plan: ImplementationPlan, sourceText = ""): boolean {
  const text = planText(plan, sourceText);
  return idempotencyPlanPattern.test(text) &&
    /\b(?:update|existing|same|duplicate|retry|idempotent|dedupe)\b/i.test(text);
}

function contentHasIdempotencyUpdatePath(content: string): boolean {
  const blocks = content.split(/\n(?=(?:async\s+)?(?:def|function)\s+|(?:export\s+)?(?:async\s+)?function\s+|class\s+)/i);

  return blocks.some((block) => {
    const compact = block.toLowerCase().replace(/\s+/g, " ");
    const identifiesRequest = /\b(?:external_ref|externalref|external reference|idempotency|dedupe|duplicate|source)\b/.test(compact);
    const createsRequest = /(?:\b|_)(?:insert|create|add|save)(?:\b|_)/.test(compact);
    const findsExisting = /(?:\b|_)(?:select|where|find|lookup|get_or_create|existing|on conflict|upsert|merge)(?:\b|_)/.test(compact);
    const updatesExisting = /(?:\b|_)(?:update|on conflict|upsert|merge|set)(?:\b|_)/.test(compact);
    return identifiesRequest && createsRequest && findsExisting && updatesExisting;
  });
}

export function validatePlanCompletion(changes: GeneratedChange[], plan: ImplementationPlan | undefined, sourceText = ""): string[] {
  if (!plan) {
    return [];
  }

  const errors: string[] = [];
  errors.push(...generatedTestListFieldErrors(changes));
  errors.push(...validatePlannedChangeScope(changes, plan, sourceText));

  if (planRequiresBehavioralTests(plan, sourceText) && changedTestFiles(changes).length === 0) {
    errors.push("Implementation plan requires behavioral test coverage, but the generated change does not modify any test/spec file");
  }

  const runtimeChanges = changedRuntimeFiles(changes);
  if (planRequiresRuntimeChange(plan) && runtimeChanges.length === 0) {
    errors.push("Implementation plan requires runtime/source changes, but the generated change only modifies tests or documentation");
  }

  for (const endpointPath of extractEndpointPaths(plan, sourceText)) {
    if (!runtimeChanges.some((change) => contentContainsEndpointPath(change.modifiedContent, endpointPath))) {
      errors.push(`Acceptance criteria require endpoint path ${endpointPath}, but no implementation change appears to route or handle that path`);
    }
  }

  if (planRequiresIdempotencyUpdate(plan, sourceText) && !runtimeChanges.some((change) => contentHasIdempotencyUpdatePath(change.modifiedContent))) {
    errors.push("Acceptance criteria require an idempotent duplicate/retry update path, but no implementation change appears to look up and update an existing record by the idempotency key");
  }

  for (const terms of extractOrderedClauses(plan, sourceText)) {
    const matched = runtimeChanges.some((change) => contentContainsTermsInOrder(change.modifiedContent, terms));
    if (!matched) {
      errors.push(`Acceptance criteria require ordered clause ${terms.join(", ")}, but no implementation change contains those terms in that order`);
    }
  }

  return errors;
}

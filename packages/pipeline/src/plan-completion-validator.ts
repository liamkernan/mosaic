import type { GeneratedChange } from "@mosaic/core";

import type { ImplementationPlan } from "./implementation-planner.js";

const behavioralKeywords = /\b(?:sort|order|ordering|rank|ranking|filter|tie-?breaker|fallback|dedupe|idempotent|permission|validation|api|endpoint|status|state)\b/i;
const testPathPattern = /(?:^|\/)(?:test|tests|spec|specs|__tests__|reported)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const documentationPathPattern = /(?:^|\/)(?:readme|changelog|docs?|documentation)(?:\/|\.|$)|\.(?:md|mdx|rst|txt)$/i;
const sourcePathPattern = /\.(?:[cm]?[jt]sx?|tsx?|py|rb|go|rs|java|kt|php|cs|swift|vue|svelte)$/i;
const staticAssetPathPattern = /\.(?:html?|css|[cm]?js)$/i;
const companionConfigPathPattern = /(?:^|\/)(?:package\.json|pnpm-workspace\.ya?ml|tsconfig(?:\.[^.]+)?\.json|jsconfig(?:\.[^.]+)?\.json|vitest\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|pyproject\.toml|setup\.py|setup\.cfg|requirements(?:-[^.]+)?\.txt|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock)$/i;
const orderedClausePattern = /`([^`]*(?:ASC|DESC|ORDER BY)[^`]*)`/gi;
const backtickedClausePattern = /`([^`]+)`/g;
const idempotencyPlanPattern = /\b(?:dedupe|duplicate|idempotent|idempotency|retry|same source|external[_\s-]?ref(?:erence)?)\b/i;
const endpointPathPattern = /\b(?:GET|POST|PUT|PATCH|DELETE)\s+(`?)(\/[a-zA-Z0-9_./:-]+)\1/g;
const quotedEndpointPathPattern = /["'`](\/[a-zA-Z0-9_./:-]+)["'`]/g;

const frontendLayerPatterns = {
  html: /\.html?$/i,
  javascript: /\.[cm]?js$/i,
  css: /\.css$/i
} as const;

const frontendLayerLabels = {
  html: "HTML",
  javascript: "JavaScript",
  css: "CSS"
} as const;

type FrontendLayer = keyof typeof frontendLayerPatterns;

interface PlannedScope {
  requiredPaths: PathFacts[];
  requiredPathList: string[];
  requiredPathText: string;
  requiredPathSet: Set<string>;
  requiredDirSet: Set<string>;
  requiresBehavioralTests: boolean;
}

interface PathFacts {
  path: string;
  dir: string;
  extension: string;
  stem: string;
  tokens?: Set<string>;
  isTest: boolean;
  isDocumentation: boolean;
  isSource: boolean;
  isStaticAsset: boolean;
  isCompanionConfig: boolean;
}

interface RuntimeChangeFacts {
  change: GeneratedChange;
  compactContent?: string;
}

interface CompletionChangeGroups {
  testChanges: GeneratedChange[];
  runtimeChanges: GeneratedChange[];
  runtimeChangeFacts: RuntimeChangeFacts[];
}

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

function collectCompletionChangeGroups(changes: GeneratedChange[]): CompletionChangeGroups {
  const testChanges: GeneratedChange[] = [];
  const runtimeChanges: GeneratedChange[] = [];
  const runtimeChangeFacts: RuntimeChangeFacts[] = [];

  for (const change of changes) {
    const isTest = testPathPattern.test(change.filePath);
    if (isTest) {
      testChanges.push(change);
    }

    if (!isTest && !documentationPathPattern.test(change.filePath)) {
      runtimeChanges.push(change);
      runtimeChangeFacts.push({ change });
    }
  }

  return { testChanges, runtimeChanges, runtimeChangeFacts };
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

function pathFacts(path: string): PathFacts {
  const normalized = normalizeRepoPath(path);
  return {
    path: normalized,
    dir: dirname(normalized),
    extension: extension(normalized),
    stem: stem(normalized),
    isTest: testPathPattern.test(normalized),
    isDocumentation: documentationPathPattern.test(normalized),
    isSource: sourcePathPattern.test(normalized),
    isStaticAsset: staticAssetPathPattern.test(normalized),
    isCompanionConfig: companionConfigPathPattern.test(normalized)
  };
}

function pathTokens(facts: PathFacts): Set<string> {
  facts.tokens ??= tokensForPath(facts.path);
  return facts.tokens;
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

function sharesMeaningfulToken(left: PathFacts, right: PathFacts): boolean {
  const rightTokens = pathTokens(right);
  for (const token of pathTokens(left)) {
    if (rightTokens.has(token)) {
      return true;
    }
  }

  return false;
}

function isStaticAssetCompanion(changed: PathFacts, required: PathFacts): boolean {
  if (!required.isStaticAsset || !changed.isStaticAsset) {
    return false;
  }

  if (required.extension === ".html" || required.extension === ".htm") {
    return changed.dir === required.dir || isChildPath(required.dir, changed.path);
  }

  if (changed.extension === ".html" || changed.extension === ".htm") {
    return required.dir === changed.dir || isChildPath(changed.dir, required.path);
  }

  return required.dir === changed.dir && sharesMeaningfulToken(changed, required);
}

function isTestCompanion(changed: PathFacts, required: PathFacts): boolean {
  if (!changed.isTest) {
    return false;
  }

  return changed.stem.includes(required.stem) ||
    required.stem.includes(changed.stem) ||
    sharesMeaningfulToken(changed, required);
}

function isCompanionConfigForRequiredFile(changed: PathFacts, required: PathFacts): boolean {
  if (!changed.isCompanionConfig) {
    return false;
  }

  return isAncestorPath(changed.dir, required.path);
}

function isAllowedPlannedCompanionChange(change: GeneratedChange, changedPath: PathFacts, requiredPath: PathFacts, requiresBehavioralTests: boolean): boolean {
  const sameDir = changedPath.dir === requiredPath.dir;

  if (sameDir && change.originalContent.length === 0 && (changedPath.isSource || changedPath.isTest)) {
    return true;
  }

  if (isStaticAssetCompanion(changedPath, requiredPath)) {
    return true;
  }

  if (isCompanionConfigForRequiredFile(changedPath, requiredPath)) {
    return true;
  }

  if ((requiresBehavioralTests || requiredPath.isTest) && isTestCompanion(changedPath, requiredPath)) {
    return true;
  }

  return false;
}

function createPlannedScope(plan: ImplementationPlan, sourceText: string): PlannedScope | null {
  const requiredPathList: string[] = [];
  const requiredPathSet = new Set<string>();
  for (const file of plan.requiredFiles) {
    const normalizedPath = normalizeRepoPath(file.path);
    if (normalizedPath.length > 0 && !requiredPathSet.has(normalizedPath)) {
      requiredPathSet.add(normalizedPath);
      requiredPathList.push(normalizedPath);
    }
  }

  if (requiredPathList.length === 0) {
    return null;
  }

  const requiredPaths: PathFacts[] = [];
  const requiredDirSet = new Set<string>();
  let hasRuntimePath = false;
  for (const path of requiredPathList) {
    const facts = pathFacts(path);
    requiredPaths.push(facts);
    requiredDirSet.add(facts.dir);
    if (!facts.isTest && !facts.isDocumentation) {
      hasRuntimePath = true;
    }
  }

  if (!hasRuntimePath) {
    return null;
  }

  return {
    requiredPaths,
    requiredPathList,
    requiredPathText: requiredPathList.join(", "),
    requiredPathSet,
    requiredDirSet,
    requiresBehavioralTests: planRequiresBehavioralTests(plan, sourceText)
  };
}

function plannedChangeScopeError(change: GeneratedChange, scope: PlannedScope): string | null {
  const normalizedChangedPath = normalizeRepoPath(change.filePath);
  if (scope.requiredPathSet.has(normalizedChangedPath)) {
    return null;
  }

  const changedDir = dirname(normalizedChangedPath);
  if (
    change.originalContent.length === 0 &&
    (sourcePathPattern.test(normalizedChangedPath) || testPathPattern.test(normalizedChangedPath)) &&
    scope.requiredDirSet.has(changedDir)
  ) {
    return null;
  }

  if (
    !staticAssetPathPattern.test(normalizedChangedPath) &&
    !testPathPattern.test(normalizedChangedPath) &&
    !companionConfigPathPattern.test(normalizedChangedPath)
  ) {
    return `Change for ${change.filePath} is outside the implementation plan scope. Planned files: ${scope.requiredPathText}`;
  }

  const changedPath = pathFacts(normalizedChangedPath);
  if (scope.requiredPaths.some((requiredPath) => isAllowedPlannedCompanionChange(change, changedPath, requiredPath, scope.requiresBehavioralTests))) {
    return null;
  }

  return `Change for ${change.filePath} is outside the implementation plan scope. Planned files: ${scope.requiredPathText}`;
}

function validatePlannedChangeScope(changes: GeneratedChange[], plan: ImplementationPlan, sourceText = ""): string[] {
  const scope = createPlannedScope(plan, sourceText);
  if (!scope) {
    return [];
  }

  const errors: string[] = [];
  for (const change of changes) {
    const error = plannedChangeScopeError(change, scope);
    if (error) {
      errors.push(error);
    }
  }

  return errors;
}

export function pruneChangesToPlanScope(changes: GeneratedChange[], plan: ImplementationPlan | undefined, sourceText = ""): GeneratedChange[] {
  if (!plan) {
    return changes;
  }

  const scope = createPlannedScope(plan, sourceText);
  if (!scope) {
    return changes;
  }

  return changes.filter((change) => !plannedChangeScopeError(change, scope));
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
  for (const change of changes) {
    if (testPathPattern.test(change.filePath) || !/\.py$/i.test(change.filePath)) {
      continue;
    }

    for (const [functionName, fields] of extractPythonListFunctionFields(change.modifiedContent)) {
      fieldsByFunction.set(functionName, fields);
    }
  }

  if (fieldsByFunction.size === 0) {
    return [];
  }

  const errors: string[] = [];
  for (const testChange of changes) {
    if (!testPathPattern.test(testChange.filePath)) {
      continue;
    }

    const variablesByFunction = new Map<string, string[]>();
    for (const assignmentMatch of testChange.modifiedContent.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(list_[a-zA-Z0-9_]*)\s*\(/g)) {
      const functionName = assignmentMatch[2];
      if (!fieldsByFunction.has(functionName)) {
        continue;
      }

      const variables = variablesByFunction.get(functionName);
      if (variables) {
        variables.push(assignmentMatch[1]);
      } else {
        variablesByFunction.set(functionName, [assignmentMatch[1]]);
      }
    }

    if (variablesByFunction.size === 0) {
      continue;
    }

    const fieldsByVariable = new Map<string, string[]>();
    for (const fieldMatch of testChange.modifiedContent.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\[\s*\d+\s*\]\s*\[\s*["']([^"']+)["']\s*\]/g)) {
      const fields = fieldsByVariable.get(fieldMatch[1]);
      if (fields) {
        fields.push(fieldMatch[2].toLowerCase());
      } else {
        fieldsByVariable.set(fieldMatch[1], [fieldMatch[2].toLowerCase()]);
      }
    }

    for (const [functionName, availableFields] of fieldsByFunction) {
      for (const variableName of variablesByFunction.get(functionName) ?? []) {
        for (const fieldName of fieldsByVariable.get(variableName) ?? []) {
          if (!availableFields.has(fieldName)) {
            errors.push(`Generated test asserts field "${fieldName}" on ${functionName} result, but no implementation change exposes that field on the list response`);
          }
        }
      }
    }
  }

  return errors;
}

function planRequiresBehavioralTests(plan: ImplementationPlan, text: string): boolean {
  const testChangePattern = /\b(?:add|update|create|write|extend|modify)\b.{0,80}\b(?:tests?|coverage|unittest|pytest|jest|vitest|spec(?:ification)?\s+(?:file|test|coverage))\b/i;
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

function plannedRuntimePaths(plan: ImplementationPlan): Set<string> {
  return new Set(plan.requiredFiles
    .map((file) => normalizeRepoPath(file.path))
    .filter((path) => !testPathPattern.test(path) && !documentationPathPattern.test(path)));
}

function missingRequiredFrontendLayerErrors(
  changes: GeneratedChange[],
  plan: ImplementationPlan
): string[] {
  const plannedPathsByLayer = new Map<FrontendLayer, string[]>();
  for (const layer of Object.keys(frontendLayerPatterns) as FrontendLayer[]) {
    const pattern = frontendLayerPatterns[layer];
    plannedPathsByLayer.set(
      layer,
      plan.requiredFiles
        .map((file) => normalizeRepoPath(file.path))
        .filter((path) => pattern.test(path))
    );
  }

  if ([...plannedPathsByLayer.values()].some((paths) => paths.length === 0)) {
    return [];
  }

  const changedPaths = changes.map((change) => normalizeRepoPath(change.filePath));
  const errors: string[] = [];
  for (const [layer, pattern] of Object.entries(frontendLayerPatterns) as Array<[FrontendLayer, RegExp]>) {
    if (!changedPaths.some((path) => pattern.test(path))) {
      const label = frontendLayerLabels[layer];
      errors.push(
        `[missing-frontend-layer:${layer}] Implementation plan requires complete HTML, JavaScript, and CSS layers, but generated changes omit the ${label} layer. Planned ${label} files: ${plannedPathsByLayer.get(layer)?.join(", ")}`
      );
    }
  }

  return errors;
}

function orderedClauseTerms(clause: string): string[] {
  const normalized = clause
    .replace(/\bORDER\s+BY\b/gi, "")
    .replace(/\bthen\b/gi, ",");

  const terms: string[] = [];
  for (const rawPart of normalized.split(",")) {
    const part = rawPart.trim();
    if (part.length === 0) {
      continue;
    }

    const match = part.match(/([a-zA-Z_][a-zA-Z0-9_.]*)\s+(ASC|DESC)\b/i);
    if (!match) {
      continue;
    }

    const field = match[1];
    const dotIndex = field.lastIndexOf(".");
    terms.push(`${dotIndex >= 0 ? field.slice(dotIndex + 1) : field} ${match[2].toUpperCase()}`);
  }

  return terms;
}

function extractOrderedClauses(text: string): string[][] {
  const clauses: string[][] = [];
  let match: RegExpExecArray | null;

  while ((match = orderedClausePattern.exec(text)) !== null) {
    const terms = orderedClauseTerms(match[1]);
    if (terms.length >= 2) {
      clauses.push(terms);
    }
  }

  for (const line of text.split("\n")) {
    const backtickedTerms: string[] = [];
    backtickedClausePattern.lastIndex = 0;
    let termMatch: RegExpExecArray | null;
    while ((termMatch = backtickedClausePattern.exec(line)) !== null) {
      for (const term of orderedClauseTerms(termMatch[1])) {
        backtickedTerms.push(term);
      }
    }

    if (backtickedTerms.length >= 2) {
      clauses.push(backtickedTerms);
    }
  }

  return clauses;
}

function compactContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ");
}

function runtimeCompactContent(facts: RuntimeChangeFacts): string {
  facts.compactContent ??= compactContent(facts.change.modifiedContent);
  return facts.compactContent;
}

function contentContainsTermsInOrder(compact: string, terms: string[]): boolean {
  let cursor = 0;

  for (const term of terms) {
    const lowerTerm = term.toLowerCase();
    const separatorIndex = lowerTerm.lastIndexOf(" ");
    const field = separatorIndex >= 0 ? lowerTerm.slice(0, separatorIndex) : lowerTerm;
    const direction = separatorIndex >= 0 ? lowerTerm.slice(separatorIndex + 1) : "";
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

function extractEndpointPaths(text: string): string[] {
  const paths: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = endpointPathPattern.exec(text)) !== null) {
    paths.push(match[2]);
  }

  return [...new Set(paths)];
}

function collectQuotedEndpointPaths(changes: GeneratedChange[]): Set<string> {
  const paths = new Set<string>();
  let match: RegExpExecArray | null;

  for (const change of changes) {
    quotedEndpointPathPattern.lastIndex = 0;
    while ((match = quotedEndpointPathPattern.exec(change.modifiedContent)) !== null) {
      paths.add(match[1]);
    }
  }

  return paths;
}

function planRequiresIdempotencyUpdate(text: string): boolean {
  return idempotencyPlanPattern.test(text) &&
    /\b(?:update|existing|same|duplicate|retry|idempotent|dedupe)\b/i.test(text);
}

function contentHasIdempotencyUpdatePath(content: string): boolean {
  const blocks = content.toLowerCase().split(/\n(?=(?:async\s+)?(?:def|function)\s+|(?:export\s+)?(?:async\s+)?function\s+|class\s+)/i);

  return blocks.some((block) => {
    const compact = block.replace(/\s+/g, " ");
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

  const text = planText(plan, sourceText);
  const errors: string[] = [];
  errors.push(...generatedTestListFieldErrors(changes));
  errors.push(...validatePlannedChangeScope(changes, plan, sourceText));
  errors.push(...missingRequiredFrontendLayerErrors(changes, plan));

  const { testChanges, runtimeChanges, runtimeChangeFacts } = collectCompletionChangeGroups(changes);
  const requiredRuntimePaths = plannedRuntimePaths(plan);
  if (planRequiresBehavioralTests(plan, text) && testChanges.length === 0) {
    errors.push("Implementation plan requires behavioral test coverage, but the generated change does not modify any test/spec file");
  }

  if (requiredRuntimePaths.size > 0 && runtimeChanges.length === 0) {
    errors.push("Implementation plan requires runtime/source changes, but the generated change only modifies tests or documentation");
  }
  if (requiredRuntimePaths.size > 0 && !changes.some((change) => requiredRuntimePaths.has(normalizeRepoPath(change.filePath)))) {
    errors.push("Implementation plan requires a change to at least one planned runtime/source file, but generated changes only add companion files");
  }

  const requiredEndpointPaths = extractEndpointPaths(sourceText);
  if (requiredEndpointPaths.length > 0) {
    const runtimeEndpointPaths = collectQuotedEndpointPaths(runtimeChanges);
    for (const endpointPath of requiredEndpointPaths) {
      if (!runtimeEndpointPaths.has(endpointPath)) {
        errors.push(`Acceptance criteria require endpoint path ${endpointPath}, but no implementation change appears to route or handle that path`);
      }
    }
  }

  if (planRequiresIdempotencyUpdate(text) && !runtimeChanges.some((change) => contentHasIdempotencyUpdatePath(change.modifiedContent))) {
    errors.push("Acceptance criteria require an idempotent duplicate/retry update path, but no implementation change appears to look up and update an existing record by the idempotency key");
  }

  for (const terms of extractOrderedClauses(text)) {
    const matched = runtimeChangeFacts.some((facts) => contentContainsTermsInOrder(runtimeCompactContent(facts), terms));
    if (!matched) {
      errors.push(`Acceptance criteria require ordered clause ${terms.join(", ")}, but no implementation change contains those terms in that order`);
    }
  }

  return errors;
}

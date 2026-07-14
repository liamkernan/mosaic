import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultSecurityConfig, type FileNode, type GeneratedChange, type RepoContext } from "@mosaic/core";
import ts from "typescript";

import { validateRepoRelativePath } from "./repo-paths.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ValidationLimits {
  maxLinesAdded?: number;
  maxChangedLines?: number;
  blockPatterns?: string[];
}

const urlPattern = /\bhttps?:\/\/[^\s"'`]+/g;
const ipPattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const modalTokenPattern = /\b[a-z0-9-]*(?:modal|overlay|dialog)(?:-[a-z0-9]+)*\b/gi;
const semanticModalTokens = new Set(["aria-modal", "dialog"]);
const htmlTagPattern = /<([a-z0-9-]+)\b([^>]*)>/gi;
const inertAnchorPattern = /<a\b(?=[^>]*\bhref\s*=\s*["'](?:#|javascript:void\(0\);?|)["'])[^>]*>[\s\S]*?<\/a>/gi;
const nonInteractiveClickableTagPattern = /<(div|article|section|li|span|figure)\b[^>]*(?:\bonclick\s*=|\bclass\s*=\s*["'][^"']*(?:clickable|interactive|card-link)[^"']*["'])[^>]*>/gi;
const getElementByIdPattern = /getElementById\(\s*["']([^"']+)["']\s*\)/g;
const querySelectorPattern = /querySelector(?:All)?\(\s*["']([^"']+)["']\s*\)/g;
const testFilePathPattern = /(?:^|\/)(?:test|tests|spec|specs|__tests__|reported)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const testAssertionPattern = /\bassert\b|self\.assert[A-Z][A-Za-z]*\s*\(|\bexpect\s*\(|\bshould\s*\(|\btoEqual\s*\(|\btoBe\s*\(|\btoContain\s*\(/g;
const testSkipPattern = /@(?:unittest\.)?skip\b|pytest\.mark\.skip\b|\b(?:describe|it|test)\.skip\s*\(|\b(?:xdescribe|xit)\s*\(/i;
const trivialAssertionPattern = /^\s*(?:assert\s+True\b|self\.assertTrue\(\s*True\s*\)|expect\(\s*true\s*\)\.(?:toBe|toEqual)\(\s*true\s*\)|expect\(\s*true\s*\)\.toBeTruthy\(\s*\))/i;
const pythonSyntaxConcurrency = 8;
const repoFileLookupCache = new WeakMap<FileNode[], Map<string, string | undefined>>();
const pythonBuiltinCallNames = new Set([
  "dict",
  "int",
  "len",
  "list",
  "max",
  "min",
  "open",
  "print",
  "range",
  "set",
  "str",
  "sum",
  "super",
  "tuple"
]);

interface HtmlFacts {
  html: string;
  ids: Set<string>;
  tagsByClass: Map<string, string[]>;
}

interface LineChangeStats {
  changedLines: number;
  addedLines: number;
  addedChangedLines: string[];
  modifiedChangedText: string;
}

interface ModalStyleFacts {
  lowerStyles: string;
  compactStyles: string;
}

interface ModalScriptFacts {
  lowerScript: string;
  compactScript: string;
  hasCompleteModalBehavior: boolean;
}

function changedLineWindow(originalLines: string[], modifiedLines: string[]): { start: number; originalEnd: number; modifiedEnd: number } {
  let start = 0;
  while (
    start < originalLines.length &&
    start < modifiedLines.length &&
    originalLines[start] === modifiedLines[start]
  ) {
    start += 1;
  }

  let originalEnd = originalLines.length - 1;
  let modifiedEnd = modifiedLines.length - 1;
  while (
    originalEnd >= start &&
    modifiedEnd >= start &&
    originalLines[originalEnd] === modifiedLines[modifiedEnd]
  ) {
    originalEnd -= 1;
    modifiedEnd -= 1;
  }

  return { start, originalEnd, modifiedEnd };
}

function lineChangeStats(original: string, modified: string): LineChangeStats {
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");
  const originalSet = new Set(originalLines);
  let addedLines = 0;
  const addedChangedLines: string[] = [];
  const { start, originalEnd, modifiedEnd } = changedLineWindow(originalLines, modifiedLines);
  const changedModifiedLines = modifiedLines.slice(start, modifiedEnd + 1);

  for (let index = start; index <= modifiedEnd; index += 1) {
    const line = modifiedLines[index];
    if (line.trim().length > 0 && !originalSet.has(line)) {
      addedLines += 1;
      addedChangedLines.push(line);
    }
  }

  const modifiedChangedText = changedModifiedLines.join("\n");
  if (originalLines.length === 0) {
    return { changedLines: modifiedLines.length, addedLines, addedChangedLines, modifiedChangedText };
  }

  if (modifiedLines.length === 0) {
    return { changedLines: originalLines.length, addedLines, addedChangedLines, modifiedChangedText };
  }

  const changedOriginalLines = originalLines.slice(start, originalEnd + 1);
  if (changedOriginalLines.length === 0 || changedModifiedLines.length === 0) {
    return {
      changedLines: changedOriginalLines.length + changedModifiedLines.length,
      addedLines,
      addedChangedLines,
      modifiedChangedText
    };
  }

  const commonLines = longestCommonSubsequenceLength(changedOriginalLines, changedModifiedLines);
  return {
    changedLines: (changedOriginalLines.length - commonLines) + (changedModifiedLines.length - commonLines),
    addedLines,
    addedChangedLines,
    modifiedChangedText
  };
}

function dynamicLongestCommonSubsequenceLength(left: string[], right: string[]): number {
  let previous = new Array<number>(right.length + 1).fill(0);

  for (const leftLine of left) {
    const current = new Array<number>(right.length + 1).fill(0);

    for (let index = 0; index < right.length; index += 1) {
      current[index + 1] = leftLine === right[index]
        ? previous[index] + 1
        : Math.max(current[index], previous[index + 1]);
    }

    previous = current;
  }

  return previous[right.length];
}

function lowerBound(values: number[], target: number): number {
  let left = 0;
  let right = values.length;

  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (values[middle] < target) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }

  return left;
}

function longestCommonSubsequenceLength(left: string[], right: string[]): number {
  const positionsByLine = new Map<string, number[]>();
  for (let index = right.length - 1; index >= 0; index -= 1) {
    const line = right[index];
    const positions = positionsByLine.get(line);
    if (positions) {
      positions.push(index);
    } else {
      positionsByLine.set(line, [index]);
    }
  }

  let matchCount = 0;
  for (const line of left) {
    matchCount += positionsByLine.get(line)?.length ?? 0;
  }

  if (matchCount > (left.length * right.length) / 4) {
    return dynamicLongestCommonSubsequenceLength(left, right);
  }

  const tails: number[] = [];
  for (const line of left) {
    for (const index of positionsByLine.get(line) ?? []) {
      tails[lowerBound(tails, index)] = index;
    }
  }

  return tails.length;
}

function findAddedMatches(pattern: RegExp, original: string, modified: string, modifiedSearchText = modified): string[] {
  const modifiedMatches = [...new Set(modifiedSearchText.match(pattern) ?? [])];
  if (modifiedMatches.length === 0) {
    return [];
  }

  const originalMatches = new Set(original.match(pattern) ?? []);
  return modifiedMatches.filter((match) => !originalMatches.has(match));
}

function countTestAssertions(content: string): number {
  let count = 0;
  testAssertionPattern.lastIndex = 0;
  while (testAssertionPattern.exec(content) !== null) {
    count += 1;
  }

  testAssertionPattern.lastIndex = 0;
  return count;
}

function validateTestIntegrity(changes: GeneratedChange[], lineStats: LineChangeStats[], errors: string[]): void {
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    if (!testFilePathPattern.test(change.filePath)) {
      continue;
    }

    const originalAssertions = countTestAssertions(change.originalContent);
    const modifiedAssertions = countTestAssertions(change.modifiedContent);
    if (originalAssertions > 0 && modifiedAssertions < originalAssertions) {
      errors.push(`Change for ${change.filePath} weakens existing test assertions (${originalAssertions} -> ${modifiedAssertions})`);
    }

    const suspiciousAddedLines = lineStats[index].addedChangedLines
      .filter((line) => testSkipPattern.test(line) || trivialAssertionPattern.test(line));
    if (suspiciousAddedLines.length > 0) {
      errors.push(`Change for ${change.filePath} adds skipped or trivial test assertions: ${suspiciousAddedLines.map((line) => line.trim()).join(", ")}`);
    }
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function summarizeHtml(html: string): string {
  const text = stripHtml(html);
  if (text.length === 0) {
    return html.replace(/\s+/g, " ").slice(0, 80);
  }

  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function hasAccessibleNonNativeInteraction(tag: string): boolean {
  return /\brole\s*=\s*["'](?:button|link)["']/i.test(tag) && /\btabindex\s*=\s*["']0["']/i.test(tag);
}

function findAddedNonInteractiveClickableTags(original: string, modified: string): string[] {
  const originalMatches = new Set(original.match(nonInteractiveClickableTagPattern) ?? []);
  return [...new Set(modified.match(nonInteractiveClickableTagPattern) ?? [])]
    .filter((match) => !originalMatches.has(match))
    .filter((match) => !hasAccessibleNonNativeInteraction(match));
}

function findAddedAccessibleNonNativeInteractiveTags(original: string, modified: string): string[] {
  const originalMatches = new Set(original.match(nonInteractiveClickableTagPattern) ?? []);
  return [...new Set(modified.match(nonInteractiveClickableTagPattern) ?? [])]
    .filter((match) => !originalMatches.has(match))
    .filter(hasAccessibleNonNativeInteraction);
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

async function pythonSyntaxErrorsForFile(filePath: string, contents: string): Promise<string[]> {
  if (!isPython(filePath)) {
    return [];
  }

  return new Promise((resolve) => {
    const process = spawn("python3", [
      "-c",
      [
        "import ast, sys",
        "source = sys.stdin.read()",
        "try:",
        "    ast.parse(source, filename=sys.argv[1])",
        "except SyntaxError as exc:",
        "    print(f'{exc.msg} at line {exc.lineno}, column {exc.offset}', file=sys.stderr)",
        "    sys.exit(1)"
      ].join("\n"),
      filePath
    ], {
      stdio: ["pipe", "ignore", "pipe"]
    });

    let stderr = "";
    process.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    process.on("error", () => resolve([]));
    process.on("close", (code) => {
      resolve(code === 0 ? [] : [stderr.trim() || "invalid Python syntax"]);
    });
    process.stdin.end(contents);
  });
}

async function collectPythonSyntaxErrors(
  changes: GeneratedChange[],
  safePaths: Array<string | null>,
  changedLineCounts: number[]
): Promise<Map<number, string[]>> {
  const errorsByIndex = new Map<number, string[]>();
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= changes.length) {
        return;
      }

      const change = changes[index];
      if (!safePaths[index] || changedLineCounts[index] === 0 || !isPython(change.filePath)) {
        continue;
      }

      errorsByIndex.set(index, await pythonSyntaxErrorsForFile(change.filePath, change.modifiedContent));
    }
  }

  const workerCount = Math.min(pythonSyntaxConcurrency, changes.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return errorsByIndex;
}

async function collectFileExistence(
  changes: GeneratedChange[],
  safePaths: Array<string | null>,
  localPath: string
): Promise<Map<number, boolean>> {
  const entries = await Promise.all(changes.map(async (change, index) => {
    const safePath = safePaths[index];
    if (!safePath || change.originalContent.length === 0) {
      return undefined;
    }

    const exists = await access(join(localPath, safePath)).then(
      () => true,
      () => false
    );
    return [index, exists] as const;
  }));

  return new Map(entries.filter((entry): entry is readonly [number, boolean] => entry !== undefined));
}

function modalElementHookTokens(content: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of content.matchAll(htmlTagPattern)) {
    const tag = match[1].toLowerCase();
    const attributes = match[2];
    const hasDialogSemantics = tag === "dialog" ||
      /\brole\s*=\s*["']dialog["']/i.test(attributes) ||
      /\baria-modal\s*=\s*["']true["']/i.test(attributes);
    if (!hasDialogSemantics) {
      continue;
    }

    const elementTokens: string[] = [];
    const id = attributes.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1];
    if (id) {
      elementTokens.push(id.toLowerCase());
    }
    const classes = attributes.match(/\bclass\s*=\s*["']([^"']+)["']/i)?.[1];
    if (classes) {
      elementTokens.push(...classes.toLowerCase().split(/\s+/).filter(Boolean));
    }
    if (elementTokens.length === 0) {
      elementTokens.push(tag === "dialog" ? "dialog" : "role-dialog");
    }
    for (const token of elementTokens) {
      tokens.add(token);
    }
  }
  return tokens;
}

function findNewModalTokens(original: string, modified: string): string[] {
  const originalMatches = new Set([
    ...(original.match(modalTokenPattern) ?? [])
      .map((match) => match.toLowerCase())
      .filter((match) => !semanticModalTokens.has(match)),
    ...modalElementHookTokens(original)
  ]);
  const modifiedMatches = new Set([
    ...(modified.match(modalTokenPattern) ?? [])
      .map((match) => match.toLowerCase())
      .filter((match) => !semanticModalTokens.has(match)),
    ...modalElementHookTokens(modified)
  ]);
  return [...modifiedMatches].filter((match) => !originalMatches.has(match));
}

function compactToken(token: string): string {
  return token.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function hasModalOpenBehavior(script: string, lowerScript = script.toLowerCase()): boolean {
  return /(?:addeventlistener|onclick|showmodal|classlist\.add|setattribute\(\s*["']aria-hidden["']\s*,\s*["']false["']|hidden\s*=\s*false)/i.test(script) &&
    /(?:modal|overlay|dialog)/i.test(lowerScript);
}

function hasModalCloseBehavior(script: string, lowerScript = script.toLowerCase()): boolean {
  return /(?:close\(\)|classlist\.remove|setattribute\(\s*["']aria-hidden["']\s*,\s*["']true["']|hidden\s*=\s*true)/i.test(script) &&
    /(?:modal|overlay|dialog|close)/i.test(lowerScript);
}

function hasModalKeyboardBehavior(script: string, lowerScript = script.toLowerCase()): boolean {
  return /(?:keydown|keyup|keypress|escape|enter|code\s*===\s*["']space["']|key\s*===\s*["']\s["'])/i.test(script) &&
    /(?:modal|overlay|dialog)/i.test(lowerScript);
}

function hasModalBehavior(script: string, lowerScript = script.toLowerCase()): boolean {
  return hasModalOpenBehavior(script, lowerScript) &&
    hasModalCloseBehavior(script, lowerScript) &&
    hasModalKeyboardBehavior(script, lowerScript);
}

function hasNonNativeKeyboardHandler(script: string): boolean {
  return /(?:keydown|keyup|keypress)/i.test(script) &&
    /(?:enter|space|code\s*===\s*["']space["']|key\s*===\s*["']\s["']|keycode\s*===\s*(?:13|32))/i.test(script);
}

function collectModalStyleFacts(styles: string): ModalStyleFacts {
  return {
    lowerStyles: styles.toLowerCase(),
    compactStyles: compactToken(styles)
  };
}

function hasModalStyleCoverage(facts: ModalStyleFacts, tokens: string[]): boolean {
  return tokens.some((token) => facts.lowerStyles.includes(token) || facts.compactStyles.includes(compactToken(token)));
}

function collectModalScriptFacts(script: string): ModalScriptFacts {
  const lowerScript = script.toLowerCase();
  return {
    lowerScript,
    compactScript: compactToken(script),
    hasCompleteModalBehavior: hasModalBehavior(script, lowerScript)
  };
}

function collectChangedPaths(changes: GeneratedChange[]): Set<string> {
  const paths = new Set<string>();
  for (const change of changes) {
    paths.add(change.filePath);
  }

  return paths;
}

function findFileInTree(nodes: FileNode[], fileName: string): string | undefined {
  for (const node of nodes) {
    if (node.type === "file" && node.path.endsWith(fileName)) {
      return node.path;
    }

    if (node.children) {
      const nested = findFileInTree(node.children, fileName);
      if (nested) {
        return nested;
      }
    }
  }

  return undefined;
}

function findRepoFile(repoContext: RepoContext, fileName: string): string | undefined {
  let lookup = repoFileLookupCache.get(repoContext.fileTree);
  if (!lookup) {
    lookup = new Map();
    repoFileLookupCache.set(repoContext.fileTree, lookup);
  }

  if (!lookup.has(fileName)) {
    lookup.set(fileName, findFileInTree(repoContext.fileTree, fileName));
  }

  return lookup.get(fileName);
}

function isStylesheet(filePath: string): boolean {
  return /\.css$/i.test(filePath);
}

function isScript(filePath: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/i.test(filePath);
}

function isFrontendMarkupOrScript(filePath: string): boolean {
  return /\.(?:html?|[cm]?[jt]sx)$/i.test(filePath);
}

function isPython(filePath: string): boolean {
  return /\.py$/i.test(filePath);
}

function pythonModuleName(filePath: string): string {
  const withoutExtension = filePath.replace(/\.py$/i, "");
  const slashIndex = withoutExtension.lastIndexOf("/");
  return slashIndex >= 0 ? withoutExtension.slice(slashIndex + 1) : withoutExtension;
}

function pythonTopLevelFunctions(content: string): Set<string> {
  const names = new Set<string>();

  for (const match of content.matchAll(/^(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm)) {
    names.add(match[1]);
  }

  return names;
}

function pythonDefinedNames(content: string): Set<string> {
  const names = new Set<string>();

  for (const match of content.matchAll(/^(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm)) {
    names.add(match[1]);
  }

  for (const match of content.matchAll(/^class\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/gm)) {
    names.add(match[1]);
  }

  for (const match of content.matchAll(/^import\s+([^\n]+)/gm)) {
    for (const imported of match[1].split(",")) {
      const aliasMatch = imported.trim().match(/(?:\s+as\s+)?([a-zA-Z_][a-zA-Z0-9_]*)$/);
      if (aliasMatch) {
        names.add(aliasMatch[1]);
      }
    }
  }

  for (const match of content.matchAll(/^from\s+[\w.]+\s+import\s+([^\n]+)/gm)) {
    for (const imported of match[1].split(",")) {
      const aliasMatch = imported.trim().match(/(?:\s+as\s+)?([a-zA-Z_][a-zA-Z0-9_]*)$/);
      if (aliasMatch) {
        names.add(aliasMatch[1]);
      }
    }
  }

  for (const match of content.matchAll(/^from\s+[\w.]+\s+import\s+\(\s*\n([\s\S]*?)^\s*\)/gm)) {
    for (const imported of match[1].split(",")) {
      const withoutComment = imported.replace(/#.*$/gm, "").trim();
      const aliasMatch = withoutComment.match(/(?:\s+as\s+)?([a-zA-Z_][a-zA-Z0-9_]*)$/);
      if (aliasMatch) {
        names.add(aliasMatch[1]);
      }
    }
  }

  return names;
}

function pythonCallNames(content: string): Set<string> {
  const names = new Set<string>();

  for (const match of content.matchAll(/(?<![\w.])([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) {
    const name = match[1];
    if (!pythonBuiltinCallNames.has(name)) {
      names.add(name);
    }
  }

  return names;
}

function validatePythonCrossFileImports(changes: GeneratedChange[], errors: string[]): void {
  const pythonChanges = changes.filter((change) => isPython(change.filePath));
  const exportedFunctionsByModule = new Map<string, Set<string>>();

  for (const change of pythonChanges) {
    const exports = pythonTopLevelFunctions(change.modifiedContent);
    if (exports.size > 0) {
      exportedFunctionsByModule.set(pythonModuleName(change.filePath), exports);
    }
  }

  if (exportedFunctionsByModule.size === 0) {
    return;
  }

  for (const change of pythonChanges) {
    const currentModule = pythonModuleName(change.filePath);
    const definedNames = pythonDefinedNames(change.modifiedContent);
    const callNames = pythonCallNames(change.modifiedContent);

    for (const [moduleName, exportedFunctions] of exportedFunctionsByModule) {
      if (moduleName === currentModule) {
        continue;
      }

      const missingImports = [...callNames]
        .filter((name) => exportedFunctions.has(name))
        .filter((name) => !definedNames.has(name));

      if (missingImports.length > 0) {
        errors.push(`Change for ${change.filePath} calls ${missingImports.join(", ")} from ${moduleName}.py but does not import or define ${missingImports.join(", ")}`);
      }
    }
  }
}

function isLocalAssetReference(reference: string): boolean {
  return !/^(?:[a-z]+:)?\/\//i.test(reference) && !reference.startsWith("#") && !reference.startsWith("data:");
}

function normalizeAssetReference(reference: string): string {
  return reference.replace(/^\.\//, "").replace(/^\//, "");
}

function collectHtmlAssetReferences(html: string): Set<string> {
  const references = new Set<string>();
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const reference = match[1];
    if (!isLocalAssetReference(reference)) {
      continue;
    }

    const normalizedReference = normalizeAssetReference(reference);
    references.add(normalizedReference);

    for (let slashIndex = normalizedReference.indexOf("/"); slashIndex >= 0; slashIndex = normalizedReference.indexOf("/", slashIndex + 1)) {
      references.add(normalizedReference.slice(slashIndex + 1));
    }
  }

  return references;
}

function htmlReferencesAsset(references: Set<string>, filePath: string): boolean {
  return references.has(normalizeAssetReference(filePath));
}

function scriptCreatesId(script: string, id: string): boolean {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:id\\s*=\\s*["']${escapedId}["']|\\.id\\s*=\\s*["']${escapedId}["']|setAttribute\\(\\s*["']id["']\\s*,\\s*["']${escapedId}["']\\s*\\))`).test(script);
}

function tagClassValues(tag: string): string[] {
  const match = tag.match(/\bclass\s*=\s*["']([^"']*)["']/i);
  return match ? match[1].split(/\s+/).filter(Boolean) : [];
}

function collectHtmlFacts(html: string): HtmlFacts {
  const ids = new Set<string>();
  for (const match of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)) {
    ids.add(match[1].toLowerCase());
  }

  const tagsByClass = new Map<string, string[]>();
  for (const match of html.matchAll(/<[^>]+>/g)) {
    const tag = match[0];
    for (const className of tagClassValues(tag)) {
      const normalizedClass = className.toLowerCase();
      const classTags = tagsByClass.get(normalizedClass);
      if (classTags) {
        classTags.push(tag);
      } else {
        tagsByClass.set(normalizedClass, [tag]);
      }
    }
  }

  return {
    html,
    ids,
    tagsByClass
  };
}

function htmlFactsHaveId(facts: HtmlFacts, id: string): boolean {
  return facts.ids.has(id.toLowerCase());
}

function tagHasAttributeSelector(tag: string, selector: string): boolean {
  const attrMatch = selector.match(/^\[([a-zA-Z0-9_-]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
  if (!attrMatch) {
    return false;
  }

  const attrName = attrMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const attrValue = attrMatch[2]?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return attrValue
    ? new RegExp(`\\b${attrName}\\s*=\\s*["']${attrValue}["']`, "i").test(tag)
    : new RegExp(`\\b${attrName}(?:\\s*=|\\s|>|/)`, "i").test(tag);
}

function isLikelyOptionalSelector(selector: string): boolean {
  return selector.includes(":") || selector.includes(" ") || selector.includes(">") || selector.includes("+") || selector.includes("~");
}

function selectorExistsInHtml(facts: HtmlFacts, selector: string): boolean {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (selector.startsWith("#")) {
    return htmlFactsHaveId(facts, selector.slice(1));
  }

  const classAttributeMatch = selector.match(/^\.([a-zA-Z0-9_-]+)(\[[^\]]+\])$/);
  if (classAttributeMatch) {
    return (facts.tagsByClass.get(classAttributeMatch[1].toLowerCase()) ?? []).some((tag) =>
      tagHasAttributeSelector(tag, classAttributeMatch[2])
    );
  }

  if (selector.startsWith(".")) {
    return facts.tagsByClass.has(selector.slice(1).toLowerCase());
  }

  const attrMatch = selector.match(/^\[([a-zA-Z0-9_-]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
  if (attrMatch) {
    const attrName = attrMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const attrValue = attrMatch[2]?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return attrValue
      ? new RegExp(`\\b${attrName}\\s*=\\s*["']${attrValue}["']`, "i").test(facts.html)
      : new RegExp(`\\b${attrName}(?:\\s*=|\\s|>)`, "i").test(facts.html);
  }

  if (/^[a-z][a-z0-9-]*$/i.test(selector)) {
    return new RegExp(`<${escapedSelector}(?:\\s|>)`, "i").test(facts.html);
  }

  return true;
}

async function validateScriptSelectorsAgainstHtml(changes: GeneratedChange[], repoContext: RepoContext, errors: string[]): Promise<void> {
  const htmlPath = findRepoFile(repoContext, "index.html");
  if (!htmlPath) {
    return;
  }

  const htmlChange = changes.find((change) => change.filePath === htmlPath);
  const effectiveHtml = htmlChange?.modifiedContent ?? await readFile(join(repoContext.localPath, htmlPath), "utf8").catch(() => "");
  if (effectiveHtml.length === 0) {
    return;
  }
  const htmlFacts = collectHtmlFacts(effectiveHtml);

  for (const change of changes) {
    if (!isScript(change.filePath)) {
      continue;
    }

    const missingIds: string[] = [];
    const seenMissingIds = new Set<string>();
    for (const match of change.modifiedContent.matchAll(getElementByIdPattern)) {
      const id = match[1];
      if (!seenMissingIds.has(id) && !htmlFactsHaveId(htmlFacts, id) && !scriptCreatesId(change.modifiedContent, id)) {
        seenMissingIds.add(id);
        missingIds.push(id);
      }
    }

    if (missingIds.length > 0) {
      errors.push(`Change for ${change.filePath} queries missing HTML id(s): ${missingIds.join(", ")}`);
    }

    const missingSelectors: string[] = [];
    const seenMissingSelectors = new Set<string>();
    for (const match of change.modifiedContent.matchAll(querySelectorPattern)) {
      const selector = match[1];
      if (!seenMissingSelectors.has(selector) && !isLikelyOptionalSelector(selector) && !selectorExistsInHtml(htmlFacts, selector)) {
        seenMissingSelectors.add(selector);
        missingSelectors.push(selector);
      }
    }

    if (missingSelectors.length > 0) {
      errors.push(`Change for ${change.filePath} queries selector(s) with no matching HTML: ${missingSelectors.join(", ")}`);
    }
  }
}

async function validateAccessibleNonNativeControls(changes: GeneratedChange[], repoContext: RepoContext, errors: string[]): Promise<void> {
  const addedControls: Array<{ filePath: string; tags: string[] }> = [];

  for (const change of changes) {
    if (!/\.(?:html?|[cm]?[jt]sx?)$/i.test(change.filePath)) {
      continue;
    }

    const tags = findAddedAccessibleNonNativeInteractiveTags(change.originalContent, change.modifiedContent);
    if (tags.length > 0) {
      addedControls.push({ filePath: change.filePath, tags });
    }
  }

  if (addedControls.length === 0) {
    return;
  }

  const changedPaths = collectChangedPaths(changes);
  let effectiveScript = "";
  for (const change of changes) {
    if (!isScript(change.filePath)) {
      continue;
    }

    effectiveScript = effectiveScript.length === 0
      ? change.modifiedContent
      : `${effectiveScript}\n${change.modifiedContent}`;
  }
  const existingScripts = await Promise.all(["script.js", "main.js", "app.js"]
    .map((fileName) => findRepoFile(repoContext, fileName))
    .filter((filePath): filePath is string => Boolean(filePath))
    .filter((filePath) => !changedPaths.has(filePath))
    .map((filePath) => readFile(join(repoContext.localPath, filePath), "utf8").catch(() => "")));
  for (const script of existingScripts) {
    effectiveScript = effectiveScript.length === 0
      ? script
      : `${effectiveScript}\n${script}`;
  }

  if (hasNonNativeKeyboardHandler(effectiveScript)) {
    return;
  }

  for (const { filePath, tags } of addedControls) {
    errors.push(
      `Change for ${filePath} adds accessible non-native control(s) without keyboard activation behavior in scripts: ${tags.map((tag) => tag.replace(/\s+/g, " ").slice(0, 80)).join(", ")}`
    );
  }
}

async function validateStaticAssetLinks(changes: GeneratedChange[], repoContext: RepoContext, errors: string[]): Promise<void> {
  const htmlPath = findRepoFile(repoContext, "index.html");
  if (!htmlPath) {
    return;
  }

  const htmlChange = changes.find((change) => change.filePath === htmlPath);
  const effectiveHtml = htmlChange
    ? htmlChange.modifiedContent
    : await readFile(join(repoContext.localPath, htmlPath), "utf8").catch(() => "");
  const htmlAssetReferences = collectHtmlAssetReferences(effectiveHtml);

  for (const change of changes) {
    if (change.originalContent.length > 0 || testFilePathPattern.test(change.filePath) ||
        (!isScript(change.filePath) && !isStylesheet(change.filePath))) {
      continue;
    }

    if (!htmlReferencesAsset(htmlAssetReferences, change.filePath)) {
      errors.push(`New static asset ${change.filePath} is not linked from ${htmlPath}`);
    }
  }
}

async function validateModalStyling(changes: GeneratedChange[], repoContext: RepoContext, errors: string[]): Promise<void> {
  const changedPaths = collectChangedPaths(changes);
  const stylePath = findRepoFile(repoContext, "styles.css");
  if (!stylePath) {
    return;
  }

  const styleChange = changes.find((change) => change.filePath === stylePath);
  const existingStyles = styleChange
    ? styleChange.modifiedContent
    : await readFile(join(repoContext.localPath, stylePath), "utf8").catch(() => "");
  let effectiveStyles = existingStyles;
  for (const change of changes) {
    if (change.filePath !== stylePath && isStylesheet(change.filePath)) {
      effectiveStyles = `${effectiveStyles}\n${change.modifiedContent}`;
    }
  }
  const styleFacts = collectModalStyleFacts(effectiveStyles);

  for (const change of changes) {
    if (!/\.(?:html?|[cm]?[jt]sx)$/i.test(change.filePath)) {
      continue;
    }

    const newModalTokens = findNewModalTokens(change.originalContent, change.modifiedContent);
    if (newModalTokens.length === 0) {
      continue;
    }

    const missingTokens = hasModalStyleCoverage(styleFacts, newModalTokens)
      ? []
      : newModalTokens.filter((token) => !styleFacts.lowerStyles.includes(token));
    if (missingTokens.length === 0) {
      continue;
    }

    if (!changedPaths.has(stylePath)) {
      errors.push(`Change for ${change.filePath} adds modal UI hooks (${missingTokens.join(", ")}) but does not update a stylesheet with matching styles`);
      continue;
    }

    errors.push(`Change for ${change.filePath} adds modal UI hooks without matching selectors in changed stylesheets: ${missingTokens.join(", ")}`);
  }
}

async function validateModalBehavior(changes: GeneratedChange[], repoContext: RepoContext, errors: string[]): Promise<void> {
  const changedPaths = collectChangedPaths(changes);
  const scriptPath = findRepoFile(repoContext, "script.js");
  if (!scriptPath) {
    return;
  }

  const scriptChange = changes.find((change) => change.filePath === scriptPath);
  const existingScript = scriptChange
    ? scriptChange.modifiedContent
    : await readFile(join(repoContext.localPath, scriptPath), "utf8").catch(() => "");
  let effectiveScript = existingScript;
  for (const change of changes) {
    if (change.filePath !== scriptPath && isScript(change.filePath)) {
      effectiveScript = `${effectiveScript}\n${change.modifiedContent}`;
    }
  }
  const scriptFacts = collectModalScriptFacts(effectiveScript);

  for (const change of changes) {
    if (!/\.(?:html?|[cm]?[jt]sx)$/i.test(change.filePath)) {
      continue;
    }

    const newModalTokens = findNewModalTokens(change.originalContent, change.modifiedContent);
    if (newModalTokens.length === 0) {
      continue;
    }

    if (scriptFacts.hasCompleteModalBehavior) {
      continue;
    }

    const missingTokens = newModalTokens.filter((token) => !scriptFacts.lowerScript.includes(token) && !scriptFacts.compactScript.includes(compactToken(token)));
    if (missingTokens.length === 0) {
      errors.push(`Change for ${change.filePath} adds modal UI hooks without complete open/close/keyboard behavior in changed scripts`);
      continue;
    }

    if (!changedPaths.has(scriptPath)) {
      errors.push(`Change for ${change.filePath} adds modal UI hooks (${missingTokens.join(", ")}) but does not update a script with matching behavior`);
      continue;
    }

    errors.push(`Change for ${change.filePath} adds modal UI hooks without matching behavior in changed scripts: ${missingTokens.join(", ")}`);
  }
}

export async function validate(
  changes: GeneratedChange[],
  repoContext: RepoContext,
  limits: ValidationLimits = {}
): Promise<ValidationResult> {
  const errors: string[] = [];
  let totalLinesAdded = 0;
  const maxChangedLines = limits.maxChangedLines ?? defaultSecurityConfig.max_changed_lines;
  const blockedPatterns = limits.blockPatterns ?? defaultSecurityConfig.block_patterns;
  const safePaths = changes.map((change) => validateRepoRelativePath(change.filePath));
  const lineStats = changes.map((change) => lineChangeStats(change.originalContent, change.modifiedContent));
  const changedLineCounts = lineStats.map((stats) => stats.changedLines);
  const [fileExistsByIndex, pythonSyntaxErrorsByIndex] = await Promise.all([
    collectFileExistence(changes, safePaths, repoContext.localPath),
    collectPythonSyntaxErrors(changes, safePaths, changedLineCounts)
  ]);
  let hasFrontendMarkupOrScriptChange = false;
  let hasScriptChange = false;
  let hasNewStaticAssetChange = false;

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    if (!hasFrontendMarkupOrScriptChange || !hasScriptChange || !hasNewStaticAssetChange) {
      const scriptChange = isScript(change.filePath);
      if (scriptChange) {
        hasScriptChange = true;
      }
      if (scriptChange || isFrontendMarkupOrScript(change.filePath)) {
        hasFrontendMarkupOrScriptChange = true;
      }
      if (change.originalContent.length === 0 && (scriptChange || isStylesheet(change.filePath))) {
        hasNewStaticAssetChange = true;
      }
    }

    const safePath = safePaths[index];
    if (!safePath) {
      errors.push(`Unsafe generated change path rejected: ${change.filePath}`);
      continue;
    }

    if (change.originalContent.length > 0 && fileExistsByIndex.get(index) === false) {
      errors.push(`File ${change.filePath} was expected to exist but does not`);
    }

    const changedLines = changedLineCounts[index];
    if (changedLines === 0) {
      continue;
    }
    if (changedLines > maxChangedLines) {
      errors.push(`Change for ${change.filePath} is too large (${changedLines} changed lines)`);
    }

    const parseErrors = [
      ...syntaxErrorsForFile(change.filePath, change.modifiedContent),
      ...(pythonSyntaxErrorsByIndex.get(index) ?? [])
    ];
    if (parseErrors.length > 0) {
      errors.push(`Syntax validation failed for ${change.filePath}: ${parseErrors.join("; ")}`);
    }

    totalLinesAdded += lineStats[index].addedLines;

    const addedUnsafePatterns = blockedPatterns.filter(
      (pattern) => change.modifiedContent.includes(pattern) && !change.originalContent.includes(pattern)
    );
    if (addedUnsafePatterns.length > 0) {
      errors.push(`Unsafe patterns added to ${change.filePath}: ${addedUnsafePatterns.join(", ")}`);
    }

    const newUrls = findAddedMatches(urlPattern, change.originalContent, change.modifiedContent, lineStats[index].modifiedChangedText);
    if (newUrls.length > 0) {
      errors.push(`New URL(s) added to ${change.filePath}: ${newUrls.join(", ")}`);
    }

    const newIps = findAddedMatches(ipPattern, change.originalContent, change.modifiedContent, lineStats[index].modifiedChangedText);
    if (newIps.length > 0) {
      errors.push(`New IP address(es) added to ${change.filePath}: ${newIps.join(", ")}`);
    }

    if (isFrontendMarkupOrScript(change.filePath)) {
      const inertAnchors = findAddedMatches(inertAnchorPattern, change.originalContent, change.modifiedContent);
      if (inertAnchors.length > 0) {
        errors.push(
          `Change for ${change.filePath} adds inert link(s) that look clickable but do not navigate or complete a workflow: ${inertAnchors.map(summarizeHtml).join(", ")}`
        );
      }

      const nonInteractiveClickableTags = findAddedNonInteractiveClickableTags(change.originalContent, change.modifiedContent);
      if (nonInteractiveClickableTags.length > 0) {
        errors.push(
          `Change for ${change.filePath} makes non-interactive container(s) appear clickable; use native button/link elements or accessible role, tabindex, and keyboard behavior: ${nonInteractiveClickableTags.map((tag) => tag.replace(/\s+/g, " ").slice(0, 80)).join(", ")}`
        );
      }
    }

    if (change.modifiedContent.includes("process.env") && !change.originalContent.includes("process.env")) {
      errors.push(`New process.env access added to ${change.filePath}`);
    }
  }

  const maxLinesAdded = limits.maxLinesAdded ?? defaultSecurityConfig.max_lines_added;
  if (totalLinesAdded > maxLinesAdded) {
    errors.push(`Total new code added exceeds limit: ${totalLinesAdded} lines`);
  }

  if (hasFrontendMarkupOrScriptChange) {
    await validateModalStyling(changes, repoContext, errors);
    await validateModalBehavior(changes, repoContext, errors);
    await validateAccessibleNonNativeControls(changes, repoContext, errors);
  }
  if (hasNewStaticAssetChange) {
    await validateStaticAssetLinks(changes, repoContext, errors);
  }
  if (hasScriptChange) {
    await validateScriptSelectorsAgainstHtml(changes, repoContext, errors);
  }
  validatePythonCrossFileImports(changes, errors);
  validateTestIntegrity(changes, lineStats, errors);

  return {
    valid: errors.length === 0,
    errors
  };
}

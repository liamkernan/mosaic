import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { type FileNode, type GeneratedChange, type RepoContext } from "@mosaic/core";
import ts from "typescript";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ValidationLimits {
  maxLinesAdded?: number;
  maxChangedLines?: number;
  blockPatterns?: string[];
}

const defaultUnsafePatterns = ["eval(", "Function(", "child_process", "exec(", "execSync"];
const urlPattern = /\bhttps?:\/\/[^\s"'`]+/g;
const ipPattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const modalTokenPattern = /\b[a-z0-9-]*(?:modal|overlay|dialog)(?:-[a-z0-9]+)*\b/gi;
const inertAnchorPattern = /<a\b(?=[^>]*\bhref\s*=\s*["'](?:#|javascript:void\(0\);?|)["'])[^>]*>[\s\S]*?<\/a>/gi;
const nonInteractiveClickableTagPattern = /<(div|article|section|li|span|figure)\b[^>]*(?:\bonclick\s*=|\bclass\s*=\s*["'][^"']*(?:clickable|interactive|card-link)[^"']*["'])[^>]*>/gi;
const getElementByIdPattern = /getElementById\(\s*["']([^"']+)["']\s*\)/g;
const querySelectorPattern = /querySelector(?:All)?\(\s*["']([^"']+)["']\s*\)/g;

function countChangedLines(original: string, modified: string): number {
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");
  if (originalLines.length === 0) {
    return modifiedLines.length;
  }

  if (modifiedLines.length === 0) {
    return originalLines.length;
  }

  let previous = new Array<number>(modifiedLines.length + 1).fill(0);

  for (const originalLine of originalLines) {
    const current = new Array<number>(modifiedLines.length + 1).fill(0);

    for (let index = 0; index < modifiedLines.length; index += 1) {
      current[index + 1] = originalLine === modifiedLines[index]
        ? previous[index] + 1
        : Math.max(current[index], previous[index + 1]);
    }

    previous = current;
  }

  const commonLines = previous[modifiedLines.length];
  return (originalLines.length - commonLines) + (modifiedLines.length - commonLines);
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

function findNewModalTokens(original: string, modified: string): string[] {
  const originalMatches = new Set((original.match(modalTokenPattern) ?? []).map((match) => match.toLowerCase()));
  return [...new Set((modified.match(modalTokenPattern) ?? []).map((match) => match.toLowerCase()))]
    .filter((match) => !originalMatches.has(match));
}

function compactToken(token: string): string {
  return token.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function hasModalBehavior(script: string): boolean {
  const lowerScript = script.toLowerCase();
  return /(?:addeventlistener|queryselector|getelementbyid|classlist|dataset|onclick|showmodal|close\()/i.test(script) &&
    /(?:modal|overlay|dialog)/i.test(lowerScript);
}

function hasModalStyleCoverage(styles: string, tokens: string[]): boolean {
  const lowerStyles = styles.toLowerCase();
  const compactStyles = compactToken(styles);
  return tokens.some((token) => lowerStyles.includes(token) || compactStyles.includes(compactToken(token)));
}

function collectChangedPaths(changes: GeneratedChange[]): Set<string> {
  return new Set(changes.map((change) => change.filePath));
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
  return findFileInTree(repoContext.fileTree, fileName);
}

function isStylesheet(filePath: string): boolean {
  return /\.css$/i.test(filePath);
}

function isScript(filePath: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/i.test(filePath);
}

function isLocalAssetReference(reference: string): boolean {
  return !/^(?:[a-z]+:)?\/\//i.test(reference) && !reference.startsWith("#") && !reference.startsWith("data:");
}

function normalizeAssetReference(reference: string): string {
  return reference.replace(/^\.\//, "").replace(/^\//, "");
}

function htmlReferencesAsset(html: string, filePath: string): boolean {
  const normalizedPath = normalizeAssetReference(filePath);
  const references = Array.from(html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi))
    .map((match) => match[1])
    .filter(isLocalAssetReference)
    .map(normalizeAssetReference);

  return references.some((reference) => reference === normalizedPath || reference.endsWith(`/${normalizedPath}`));
}

function scriptCreatesId(script: string, id: string): boolean {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:id\\s*=\\s*["']${escapedId}["']|\\.id\\s*=\\s*["']${escapedId}["']|setAttribute\\(\\s*["']id["']\\s*,\\s*["']${escapedId}["']\\s*\\))`).test(script);
}

function htmlHasId(html: string, id: string): boolean {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bid\\s*=\\s*["']${escapedId}["']`, "i").test(html);
}

function isLikelyOptionalSelector(selector: string): boolean {
  return selector.includes(":") || selector.includes(" ") || selector.includes(">") || selector.includes("+") || selector.includes("~");
}

function selectorExistsInHtml(html: string, selector: string): boolean {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (selector.startsWith("#")) {
    return htmlHasId(html, selector.slice(1));
  }

  if (selector.startsWith(".")) {
    const className = selector.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\bclass\\s*=\\s*["'][^"']*\\b${className}\\b`, "i").test(html);
  }

  const attrMatch = selector.match(/^\[([a-zA-Z0-9_-]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
  if (attrMatch) {
    const attrName = attrMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const attrValue = attrMatch[2]?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return attrValue
      ? new RegExp(`\\b${attrName}\\s*=\\s*["']${attrValue}["']`, "i").test(html)
      : new RegExp(`\\b${attrName}(?:\\s*=|\\s|>)`, "i").test(html);
  }

  if (/^[a-z][a-z0-9-]*$/i.test(selector)) {
    return new RegExp(`<${escapedSelector}(?:\\s|>)`, "i").test(html);
  }

  return true;
}

function validateScriptSelectorsAgainstHtml(changes: GeneratedChange[], repoContext: RepoContext, errors: string[]): void {
  const htmlPath = findRepoFile(repoContext, "index.html");
  if (!htmlPath) {
    return;
  }

  const htmlChange = changes.find((change) => change.filePath === htmlPath);
  if (!htmlChange) {
    return;
  }

  const effectiveHtml = htmlChange.modifiedContent;
  for (const change of changes.filter((candidate) => isScript(candidate.filePath))) {
    const missingIds = [...new Set([...change.modifiedContent.matchAll(getElementByIdPattern)]
      .map((match) => match[1])
      .filter((id) => !htmlHasId(effectiveHtml, id) && !scriptCreatesId(change.modifiedContent, id)))];

    if (missingIds.length > 0) {
      errors.push(`Change for ${change.filePath} queries missing HTML id(s): ${missingIds.join(", ")}`);
    }

    const missingSelectors = [...new Set([...change.modifiedContent.matchAll(querySelectorPattern)]
      .map((match) => match[1])
      .filter((selector) => !isLikelyOptionalSelector(selector))
      .filter((selector) => !selectorExistsInHtml(effectiveHtml, selector)))];

    if (missingSelectors.length > 0) {
      errors.push(`Change for ${change.filePath} queries selector(s) with no matching HTML: ${missingSelectors.join(", ")}`);
    }
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

  for (const change of changes) {
    if (change.originalContent.length > 0 || (!isScript(change.filePath) && !isStylesheet(change.filePath))) {
      continue;
    }

    if (!htmlReferencesAsset(effectiveHtml, change.filePath)) {
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
  const effectiveStyles = [
    existingStyles,
    ...changes
      .filter((change) => isStylesheet(change.filePath) && change.filePath !== stylePath)
      .map((change) => change.modifiedContent)
  ].join("\n");

  for (const change of changes) {
    if (!/\.(?:html?|[cm]?[jt]sx)$/i.test(change.filePath)) {
      continue;
    }

    const newModalTokens = findNewModalTokens(change.originalContent, change.modifiedContent);
    if (newModalTokens.length === 0) {
      continue;
    }

    const missingTokens = hasModalStyleCoverage(effectiveStyles, newModalTokens)
      ? []
      : newModalTokens.filter((token) => !effectiveStyles.toLowerCase().includes(token));
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
  const effectiveScript = [
    existingScript,
    ...changes
      .filter((change) => isScript(change.filePath) && change.filePath !== scriptPath)
      .map((change) => change.modifiedContent)
  ].join("\n");

  for (const change of changes) {
    if (!/\.(?:html?|[cm]?[jt]sx)$/i.test(change.filePath)) {
      continue;
    }

    const newModalTokens = findNewModalTokens(change.originalContent, change.modifiedContent);
    if (newModalTokens.length === 0) {
      continue;
    }

    if (hasModalBehavior(effectiveScript)) {
      continue;
    }

    const compactScript = compactToken(effectiveScript);
    const missingTokens = newModalTokens.filter((token) => !effectiveScript.toLowerCase().includes(token) && !compactScript.includes(compactToken(token)));
    if (missingTokens.length === 0) {
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
  const maxChangedLines = limits.maxChangedLines ?? 500;
  const blockedPatterns = limits.blockPatterns ?? defaultUnsafePatterns;

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
    if (changedLines > maxChangedLines) {
      errors.push(`Change for ${change.filePath} is too large (${changedLines} changed lines)`);
    }

    const parseErrors = syntaxErrorsForFile(change.filePath, change.modifiedContent);
    if (parseErrors.length > 0) {
      errors.push(`Syntax validation failed for ${change.filePath}: ${parseErrors.join("; ")}`);
    }

    totalLinesAdded += countAddedLines(change.originalContent, change.modifiedContent);

    const addedUnsafePatterns = blockedPatterns.filter(
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

    if (/\.(?:html?|[cm]?[jt]sx)$/i.test(change.filePath)) {
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

  const maxLinesAdded = limits.maxLinesAdded ?? 350;
  if (totalLinesAdded >= maxLinesAdded) {
    errors.push(`Total new code added exceeds limit: ${totalLinesAdded} lines`);
  }

  await validateModalStyling(changes, repoContext, errors);
  await validateModalBehavior(changes, repoContext, errors);
  await validateStaticAssetLinks(changes, repoContext, errors);
  validateScriptSelectorsAgainstHtml(changes, repoContext, errors);

  return {
    valid: errors.length === 0,
    errors
  };
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { GeneratedChange, RepoContext } from "@mosaic/core";

const modalStyleValidationPattern =
  /Change for .+ adds modal UI hooks (?:\(([^)]+)\)|without matching selectors in ([^:]+): (.+)|but does not update ([^ ]+) with matching styles)/;
const unlinkedStaticAssetPattern = /New static asset ([^\s]+) is not linked from ([^\s]+)/;
const missingHtmlIdPattern = /queries missing HTML id\(s\): (.+)$/;
const missingHtmlSelectorPattern = /queries selector\(s\) with no matching HTML: (.+)$/;
const missingPythonImportPattern = /Change for ([^\s]+\.py) calls (.+) from ([^\s]+)\.py but does not import or define (.+)$/;

function findFilePathByName(nodes: RepoContext["fileTree"], fileName: string): string | null {
  for (const node of nodes) {
    if (node.type === "file" && node.path.endsWith(fileName)) {
      return node.path;
    }

    if (node.children) {
      const nested = findFilePathByName(node.children, fileName);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

function extractMissingModalTokens(validationErrors: string[]): string[] {
  const tokens = new Set<string>();

  for (const error of validationErrors) {
    const match = error.match(modalStyleValidationPattern);
    const tokenList = match?.[1] ?? match?.[3];
    if (!tokenList) {
      continue;
    }

    for (const token of tokenList.split(",")) {
      const normalized = token.trim().toLowerCase();
      if (/(?:modal|overlay|dialog)/.test(normalized)) {
        tokens.add(normalized);
      }
    }
  }

  return [...tokens];
}

function buildModalStyleFallback(tokens: string[]): string {
  return tokens
    .map((token) => {
      if (token.includes("overlay")) {
        return `.${token} {\n  position: fixed;\n  inset: 0;\n  display: grid;\n  place-items: center;\n  padding: 1.5rem;\n  background: rgba(20, 20, 20, 0.48);\n  z-index: 1000;\n}`;
      }

      if (token.includes("content") || token.includes("panel") || token.endsWith("modal")) {
        return `.${token} {\n  width: min(720px, 100%);\n  max-height: min(82vh, 760px);\n  overflow: auto;\n  padding: 1.5rem;\n  background: #fff;\n  border-radius: 8px;\n  box-shadow: 0 24px 70px rgba(20, 20, 20, 0.24);\n}`;
      }

      if (token.includes("meta")) {
        return `.${token} {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 0.5rem 1rem;\n  margin: 0 0 1rem;\n  color: #5f625f;\n  font-size: 0.95rem;\n}`;
      }

      if (token.includes("close")) {
        return `.${token} {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  cursor: pointer;\n}`;
      }

      return `.${token} {\n  display: block;\n}`;
    })
    .join("\n\n");
}

function findHtmlInsertTarget(nodes: RepoContext["fileTree"], htmlPath: string): string | null {
  return findFilePathByName(nodes, htmlPath);
}

function extractUnlinkedStaticAssets(validationErrors: string[]): Array<{ assetPath: string; htmlPath: string }> {
  const assets: Array<{ assetPath: string; htmlPath: string }> = [];

  for (const error of validationErrors) {
    const match = error.match(unlinkedStaticAssetPattern);
    if (!match) {
      continue;
    }

    assets.push({
      assetPath: match[1],
      htmlPath: match[2]
    });
  }

  return assets;
}

function assetTag(assetPath: string): string | null {
  if (/\.css$/i.test(assetPath)) {
    return `    <link rel="stylesheet" href="./${assetPath}" />`;
  }

  if (/\.(?:[cm]?[jt]sx?)$/i.test(assetPath)) {
    return `    <script src="./${assetPath}"></script>`;
  }

  return null;
}

function htmlAlreadyLinks(html: string, assetPath: string): boolean {
  return html.includes(`"${assetPath}"`) ||
    html.includes(`'${assetPath}'`) ||
    html.includes(`"./${assetPath}"`) ||
    html.includes(`'./${assetPath}'`);
}

function insertAssetTag(html: string, assetPath: string): string {
  if (htmlAlreadyLinks(html, assetPath)) {
    return html;
  }

  const tag = assetTag(assetPath);
  if (!tag) {
    return html;
  }

  if (/\.css$/i.test(assetPath) && /<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${tag}\n  </head>`);
  }

  if (/\.(?:[cm]?[jt]sx?)$/i.test(assetPath) && /<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${tag}\n  </body>`);
  }

  return `${html.trimEnd()}\n${tag}\n`;
}

function extractMissingHtmlHooks(validationErrors: string[]): { ids: string[]; selectors: string[] } {
  const ids = new Set<string>();
  const selectors = new Set<string>();

  for (const error of validationErrors) {
    const idMatch = error.match(missingHtmlIdPattern);
    if (idMatch) {
      for (const id of idMatch[1].split(",")) {
        const normalized = id.trim();
        if (normalized.length > 0) {
          ids.add(normalized);
        }
      }
    }

    const selectorMatch = error.match(missingHtmlSelectorPattern);
    if (selectorMatch) {
      for (const selector of selectorMatch[1].split(",")) {
        const normalized = selector.trim();
        if (normalized.length > 0) {
          selectors.add(normalized);
        }
      }
    }
  }

  return { ids: [...ids], selectors: [...selectors] };
}

function extractMissingPythonImports(validationErrors: string[]): Array<{ filePath: string; moduleName: string; names: string[] }> {
  const imports: Array<{ filePath: string; moduleName: string; names: string[] }> = [];

  for (const error of validationErrors) {
    const match = error.match(missingPythonImportPattern);
    if (!match) {
      continue;
    }

    imports.push({
      filePath: match[1],
      moduleName: match[3],
      names: match[4].split(",").map((name) => name.trim()).filter(Boolean)
    });
  }

  return imports;
}

function addPythonImport(content: string, moduleName: string, names: string[]): string {
  const escapedModuleName = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const importPattern = new RegExp(`^from\\s+\\.${escapedModuleName}\\s+import\\s+([^\\n]+)$`, "m");
  const existingImport = content.match(importPattern);

  if (existingImport) {
    const existingNames = existingImport[1].split(",").map((name) => name.trim()).filter(Boolean);
    const mergedNames = [...new Set([...existingNames, ...names])];
    return content.replace(importPattern, `from .${moduleName} import ${mergedNames.join(", ")}`);
  }

  const lines = content.split("\n");
  let insertAt = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^(?:from\s+__future__\s+import|from\s+[\w.]+\s+import|import\s+\w|\s*$)/.test(line)) {
      insertAt = index + 1;
      continue;
    }
    break;
  }

  lines.splice(insertAt, 0, `from .${moduleName} import ${names.join(", ")}`);
  return lines.join("\n");
}

function htmlHasId(html: string, id: string): boolean {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bid\\s*=\\s*["']${escapedId}["']`, "i").test(html);
}

function htmlHasClass(html: string, className: string): boolean {
  const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bclass\\s*=\\s*["'][^"']*\\b${escapedClassName}\\b`, "i").test(html);
}

function slugify(text: string, fallback: string): string {
  const slug = text
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function tagHasClass(tag: string, className: string): boolean {
  const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bclass\\s*=\\s*["'][^"']*\\b${escapedClassName}\\b`, "i").test(tag);
}

function tagHasAttribute(tag: string, attrName: string): boolean {
  const escapedAttrName = attrName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escapedAttrName}(?:\\s*=|\\s|>|/)`, "i").test(tag);
}

function classTokens(className: string): string[] {
  return className
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)
    .filter((token) => !["btn", "button", "link", "trigger", "clickable", "open", "close"].includes(token));
}

function tagClassValues(tag: string): string[] {
  const match = tag.match(/\bclass\s*=\s*["']([^"']*)["']/i);
  if (!match) {
    return [];
  }

  return match[1].split(/\s+/).filter(Boolean);
}

function tagSemanticallyMatchesClass(tag: string, missingClassName: string): boolean {
  const missingTokens = classTokens(missingClassName);
  if (missingTokens.length === 0) {
    return false;
  }

  const existingTokens = new Set(tagClassValues(tag).flatMap(classTokens));
  return missingTokens.every((token) => existingTokens.has(token));
}

function addClassToTag(tag: string, className: string): string {
  if (tagHasClass(tag, className)) {
    return tag;
  }

  if (/\bclass\s*=\s*["'][^"']*["']/i.test(tag)) {
    return tag.replace(/\bclass\s*=\s*(["'])([^"']*)\1/i, (_match, quote: string, classes: string) =>
      `class=${quote}${classes.trim()} ${className}${quote}`
    );
  }

  return tag.replace(/\s*\/?>$/, ` class="${className}"$&`);
}

function inferAttributeValue(html: string, tagIndex: number, className: string, count: number): string {
  const nearbyHtml = html.slice(tagIndex, tagIndex + 600);
  const heading = nearbyHtml.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1] ??
    nearbyHtml.match(/>([^<>]{2,80})</)?.[1] ??
    "";
  return slugify(heading, `${className}-${count + 1}`);
}

function addAttributeToClassSelector(html: string, className: string, attrName: string): string {
  let count = 0;
  return html.replace(/<[a-z][a-z0-9-]*(?:\s[^<>]*)?>/gi, (tag, offset) => {
    if (!tagHasClass(tag, className) || tagHasAttribute(tag, attrName)) {
      return tag;
    }

    const value = inferAttributeValue(html, offset, className, count);
    count += 1;
    return tag.replace(/\s*\/?>$/, ` ${attrName}="${value}"$&`);
  });
}

function addClassToSemanticMatches(html: string, className: string): string {
  return html.replace(/<[a-z][a-z0-9-]*(?:\s[^<>]*)?>/gi, (tag) => {
    if (!tagSemanticallyMatchesClass(tag, className)) {
      return tag;
    }

    return addClassToTag(tag, className);
  });
}

function applySelectorHookFallbacks(html: string, selectors: string[]): string {
  let completedHtml = html;
  for (const selector of selectors) {
    const classAttrMatch = selector.match(/^\.([a-zA-Z0-9_-]+)\[([a-zA-Z0-9_-]+)\]$/);
    if (classAttrMatch) {
      completedHtml = addAttributeToClassSelector(completedHtml, classAttrMatch[1], classAttrMatch[2]);
      continue;
    }

    const classMatch = selector.match(/^\.([a-zA-Z0-9_-]+)$/);
    if (classMatch && !htmlHasClass(completedHtml, classMatch[1])) {
      completedHtml = addClassToSemanticMatches(completedHtml, classMatch[1]);
    }
  }
  return completedHtml;
}

function buildModalHookFallback(ids: string[], selectors: string[], html: string): string {
  const modalIds = ids.filter((id) => /modal|overlay|dialog|review|product|graphic|title|desc/i.test(id) && !htmlHasId(html, id));
  const modalClasses = selectors
    .map((selector) => selector.match(/^\.([a-zA-Z0-9_-]+)$/)?.[1])
    .filter((className): className is string => Boolean(className))
    .filter((className) => /modal|overlay|dialog|close|panel/i.test(className) && !htmlHasClass(html, className));

  if (modalIds.length === 0 && modalClasses.length === 0) {
    return "";
  }

  const overlayId = modalIds.find((id) => /overlay/i.test(id));
  const modalId = modalIds.find((id) => /modal|dialog/i.test(id) && id !== overlayId);
  const titleId = modalIds.find((id) => /title/i.test(id));
  const eyebrowId = modalIds.find((id) => /eyebrow|kicker|label/i.test(id));
  const descriptionId = modalIds.find((id) => /desc/i.test(id));
  const graphicId = modalIds.find((id) => /graphic|image|visual/i.test(id));
  const productsId = modalIds.find((id) => /product|item/i.test(id));
  const reviewsId = modalIds.find((id) => /review/i.test(id));
  const closeId = modalIds.find((id) => /close/i.test(id));
  const overlayClass = modalClasses.find((className) => /overlay/i.test(className)) ?? "modal-overlay";
  const panelClass = modalClasses.find((className) => /panel|modal|dialog/i.test(className) && className !== overlayClass) ?? "modal-panel";
  const closeClass = modalClasses.find((className) => /close/i.test(className)) ?? "modal-close";
  const renderedIds = new Set([overlayId, modalId, titleId, eyebrowId, descriptionId, graphicId, productsId, reviewsId, closeId].filter(Boolean));
  const extraIds = modalIds.filter((id) => !renderedIds.has(id));

  return [
    `    <div${overlayId ? ` id="${overlayId}"` : ""} class="${overlayClass}" aria-hidden="true">`,
    `      <div${modalId ? ` id="${modalId}"` : ""} class="${panelClass}" role="dialog" aria-modal="true"${titleId ? ` aria-labelledby="${titleId}"` : ""}>`,
    `        <button${closeId ? ` id="${closeId}"` : ""} class="${closeClass}" type="button" aria-label="Close">Close</button>`,
    graphicId ? `        <div id="${graphicId}" class="modal-graphic"></div>` : "",
    eyebrowId ? `        <p id="${eyebrowId}" class="modal-eyebrow"></p>` : "",
    titleId ? `        <h2 id="${titleId}"></h2>` : "",
    descriptionId ? `        <p id="${descriptionId}"></p>` : "",
    productsId ? `        <div id="${productsId}" class="modal-products"></div>` : "",
    reviewsId ? `        <div id="${reviewsId}" class="modal-reviews"></div>` : "",
    ...extraIds.map((id) => `        <div id="${id}"></div>`),
    "      </div>",
    "    </div>"
  ].filter(Boolean).join("\n");
}

function insertModalHookFallback(html: string, ids: string[], selectors: string[]): string {
  const fallbackMarkup = buildModalHookFallback(ids, selectors, html);
  if (fallbackMarkup.length === 0) {
    return html;
  }

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${fallbackMarkup}\n  </body>`);
  }

  return `${html.trimEnd()}\n${fallbackMarkup}\n`;
}

export async function completeMissingModalStyles(
  changes: GeneratedChange[],
  repoContext: RepoContext,
  validationErrors: string[]
): Promise<GeneratedChange[]> {
  const missingTokens = extractMissingModalTokens(validationErrors);
  if (missingTokens.length === 0) {
    return changes;
  }

  const stylePath = findFilePathByName(repoContext.fileTree, "styles.css");
  if (!stylePath) {
    return changes;
  }

  const existingStyleChange = changes.find((change) => change.filePath === stylePath);
  const originalContent = existingStyleChange?.originalContent ??
    await readFile(join(repoContext.localPath, stylePath), "utf8").catch(() => "");
  const baseContent = existingStyleChange?.modifiedContent ?? originalContent;
  const stylesToAdd = missingTokens
    .filter((token) => !baseContent.toLowerCase().includes(token))
    .map((token) => buildModalStyleFallback([token]))
    .filter((style) => style.trim().length > 0)
    .join("\n\n");

  if (stylesToAdd.length === 0) {
    return changes;
  }

  const modifiedContent = `${baseContent.trimEnd()}\n\n${stylesToAdd}\n`;
  if (existingStyleChange) {
    return changes.map((change) =>
      change.filePath === stylePath
        ? {
            ...change,
            modifiedContent,
            explanation: `${change.explanation} Added missing modal selectors required by validation.`
          }
        : change
    );
  }

  return [
    ...changes,
    {
      filePath: stylePath,
      originalContent,
      modifiedContent,
      explanation: "Added minimal modal styling for newly introduced modal UI hooks."
    }
  ];
}

export async function completeUnlinkedStaticAssets(
  changes: GeneratedChange[],
  repoContext: RepoContext,
  validationErrors: string[]
): Promise<GeneratedChange[]> {
  const unlinkedAssets = extractUnlinkedStaticAssets(validationErrors);
  if (unlinkedAssets.length === 0) {
    return changes;
  }

  let completedChanges = changes;
  for (const { assetPath, htmlPath } of unlinkedAssets) {
    const resolvedHtmlPath = findHtmlInsertTarget(repoContext.fileTree, htmlPath);
    if (!resolvedHtmlPath) {
      continue;
    }

    const existingHtmlChange = completedChanges.find((change) => change.filePath === resolvedHtmlPath);
    const originalContent = existingHtmlChange?.originalContent ??
      await readFile(join(repoContext.localPath, resolvedHtmlPath), "utf8").catch(() => "");
    const baseContent = existingHtmlChange?.modifiedContent ?? originalContent;
    const modifiedContent = insertAssetTag(baseContent, assetPath);
    if (modifiedContent === baseContent) {
      continue;
    }

    if (existingHtmlChange) {
      completedChanges = completedChanges.map((change) =>
        change.filePath === resolvedHtmlPath
          ? {
              ...change,
              modifiedContent,
              explanation: `${change.explanation} Linked ${assetPath} so the new static asset loads.`
            }
          : change
      );
      continue;
    }

    completedChanges = [
      ...completedChanges,
      {
        filePath: resolvedHtmlPath,
        originalContent,
        modifiedContent,
        explanation: `Linked ${assetPath} so the new static asset loads.`
      }
    ];
  }

  return completedChanges;
}

export async function completeMissingHtmlHooks(
  changes: GeneratedChange[],
  repoContext: RepoContext,
  validationErrors: string[]
): Promise<GeneratedChange[]> {
  const missingHooks = extractMissingHtmlHooks(validationErrors);
  if (missingHooks.ids.length === 0 && missingHooks.selectors.length === 0) {
    return changes;
  }

  const htmlPath = findFilePathByName(repoContext.fileTree, "index.html");
  if (!htmlPath) {
    return changes;
  }

  const existingHtmlChange = changes.find((change) => change.filePath === htmlPath);
  const originalContent = existingHtmlChange?.originalContent ??
    await readFile(join(repoContext.localPath, htmlPath), "utf8").catch(() => "");
  const baseContent = existingHtmlChange?.modifiedContent ?? originalContent;
  const withSelectorHooks = applySelectorHookFallbacks(baseContent, missingHooks.selectors);
  const modifiedContent = insertModalHookFallback(withSelectorHooks, missingHooks.ids, missingHooks.selectors);

  if (modifiedContent === baseContent) {
    return changes;
  }

  if (existingHtmlChange) {
    return changes.map((change) =>
      change.filePath === htmlPath
        ? {
            ...change,
            modifiedContent,
            explanation: `${change.explanation} Added missing HTML hooks required by validation.`
          }
        : change
    );
  }

  return [
    ...changes,
    {
      filePath: htmlPath,
      originalContent,
      modifiedContent,
      explanation: "Added missing HTML hooks required by validation."
    }
  ];
}

export async function completeMissingPythonImports(
  changes: GeneratedChange[],
  repoContext: RepoContext,
  validationErrors: string[]
): Promise<GeneratedChange[]> {
  const missingImports = extractMissingPythonImports(validationErrors);
  if (missingImports.length === 0) {
    return changes;
  }

  let completedChanges = changes;
  for (const missingImport of missingImports) {
    const existingChange = completedChanges.find((change) => change.filePath === missingImport.filePath);
    const originalContent = existingChange?.originalContent ??
      await readFile(join(repoContext.localPath, missingImport.filePath), "utf8").catch(() => "");
    const baseContent = existingChange?.modifiedContent ?? originalContent;
    const modifiedContent = addPythonImport(baseContent, missingImport.moduleName, missingImport.names);

    if (modifiedContent === baseContent) {
      continue;
    }

    if (existingChange) {
      completedChanges = completedChanges.map((change) =>
        change.filePath === missingImport.filePath
          ? {
              ...change,
              modifiedContent,
              explanation: `${change.explanation} Added missing Python import required by validation.`
            }
          : change
      );
      continue;
    }

    completedChanges = [
      ...completedChanges,
      {
        filePath: missingImport.filePath,
        originalContent,
        modifiedContent,
        explanation: "Added missing Python import required by validation."
      }
    ];
  }

  return completedChanges;
}

export async function applyValidationFallbacks(
  changes: GeneratedChange[],
  repoContext: RepoContext,
  validationErrors: string[]
): Promise<GeneratedChange[]> {
  const withHooks = await completeMissingHtmlHooks(changes, repoContext, validationErrors);
  const withStyles = await completeMissingModalStyles(withHooks, repoContext, validationErrors);
  const withAssets = await completeUnlinkedStaticAssets(withStyles, repoContext, validationErrors);
  return completeMissingPythonImports(withAssets, repoContext, validationErrors);
}

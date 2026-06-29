import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { GeneratedChange, RepoContext } from "@mosaic/core";

interface ChangeUpdater {
  changes: GeneratedChange[];
  indexesByPath: Map<string, number[]>;
  copied: boolean;
}

const modalStyleValidationPattern =
  /Change for .+ adds modal UI hooks (?:\(([^)]+)\)|without matching selectors in ([^:]+): (.+)|but does not update ([^ ]+) with matching styles)/;
const unlinkedStaticAssetPattern = /New static asset ([^\s]+) is not linked from ([^\s]+)/;
const missingHtmlIdPattern = /queries missing HTML id\(s\): (.+)$/;
const missingHtmlSelectorPattern = /queries selector\(s\) with no matching HTML: (.+)$/;
const missingPythonImportPattern = /Change for ([^\s]+\.py) calls (.+) from ([^\s]+)\.py but does not import or define (.+)$/;
const filePathByNameCache = new WeakMap<RepoContext["fileTree"], Map<string, string | null>>();

function createChangeUpdater(changes: GeneratedChange[]): ChangeUpdater {
  const indexesByPath = new Map<string, number[]>();
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    const indexes = indexesByPath.get(change.filePath);
    if (indexes) {
      indexes.push(index);
    } else {
      indexesByPath.set(change.filePath, [index]);
    }
  }

  return {
    changes,
    indexesByPath,
    copied: false
  };
}

function copyChangesForUpdate(updater: ChangeUpdater): GeneratedChange[] {
  if (!updater.copied) {
    updater.changes = updater.changes.slice();
    updater.copied = true;
  }

  return updater.changes;
}

function findChange(updater: ChangeUpdater, filePath: string): GeneratedChange | undefined {
  const indexes = updater.indexesByPath.get(filePath);
  return indexes ? updater.changes[indexes[0]] : undefined;
}

function updateChangesForPath(
  updater: ChangeUpdater,
  filePath: string,
  update: (change: GeneratedChange) => GeneratedChange
): void {
  const indexes = updater.indexesByPath.get(filePath);
  if (!indexes) {
    return;
  }

  const changes = copyChangesForUpdate(updater);
  for (const index of indexes) {
    changes[index] = update(changes[index]);
  }
}

function appendChange(updater: ChangeUpdater, change: GeneratedChange): void {
  const changes = copyChangesForUpdate(updater);
  const index = changes.length;
  changes.push(change);
  updater.indexesByPath.set(change.filePath, [index]);
}

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

function cachedFilePathByName(nodes: RepoContext["fileTree"], fileName: string): string | null {
  let lookup = filePathByNameCache.get(nodes);
  if (!lookup) {
    lookup = new Map();
    filePathByNameCache.set(nodes, lookup);
  }

  if (!lookup.has(fileName)) {
    lookup.set(fileName, findFilePathByName(nodes, fileName));
  }

  return lookup.get(fileName) ?? null;
}

function findHtmlInsertTarget(nodes: RepoContext["fileTree"], htmlPath: string): string | null {
  return cachedFilePathByName(nodes, htmlPath);
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

function insertAssetTags(html: string, assetPaths: string[]): string {
  const cssTags: string[] = [];
  const scriptTags: string[] = [];
  const seenAssetPaths = new Set<string>();

  for (const assetPath of assetPaths) {
    if (seenAssetPaths.has(assetPath) || htmlAlreadyLinks(html, assetPath)) {
      continue;
    }

    seenAssetPaths.add(assetPath);
    const tag = assetTag(assetPath);
    if (!tag) {
      continue;
    }

    if (/\.css$/i.test(assetPath)) {
      cssTags.push(tag);
    } else if (/\.(?:[cm]?[jt]sx?)$/i.test(assetPath)) {
      scriptTags.push(tag);
    }
  }

  let completedHtml = html;
  if (cssTags.length > 0) {
    completedHtml = /<\/head>/i.test(completedHtml)
      ? completedHtml.replace(/<\/head>/i, `${cssTags.join("\n")}\n  </head>`)
      : `${completedHtml.trimEnd()}\n${cssTags.join("\n")}\n`;
  }

  if (scriptTags.length > 0) {
    completedHtml = /<\/body>/i.test(completedHtml)
      ? completedHtml.replace(/<\/body>/i, `${scriptTags.join("\n")}\n  </body>`)
      : `${completedHtml.trimEnd()}\n${scriptTags.join("\n")}\n`;
  }

  return completedHtml;
}

function assetLinkExplanation(assetPaths: string[]): string {
  return assetPaths.length === 1
    ? `Linked ${assetPaths[0]} so the new static asset loads.`
    : `Linked ${assetPaths.length} new static assets so they load.`;
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
      names: splitCommaSeparatedNames(match[4])
    });
  }

  return imports;
}

function splitCommaSeparatedNames(text: string): string[] {
  const names: string[] = [];
  for (const rawName of text.split(",")) {
    const name = rawName.trim();
    if (name.length > 0) {
      names.push(name);
    }
  }

  return names;
}

function addPythonImport(content: string, moduleSpecifier: string, names: string[]): string {
  const escapedModuleSpecifier = moduleSpecifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const importPattern = new RegExp(`^from\\s+${escapedModuleSpecifier}\\s+import\\s+([^\\n]+)$`, "m");
  const existingImport = content.match(importPattern);

  if (existingImport) {
    const existingNames = existingImport[1].split(",").map((name) => name.trim()).filter(Boolean);
    const mergedNames = [...new Set([...existingNames, ...names])];
    return content.replace(importPattern, `from ${moduleSpecifier} import ${mergedNames.join(", ")}`);
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

  lines.splice(insertAt, 0, `from ${moduleSpecifier} import ${names.join(", ")}`);
  return lines.join("\n");
}

function pythonImportSpecifier(targetPath: string, sourcePath: string | null, moduleName: string): string {
  if (!sourcePath || dirname(targetPath) === dirname(sourcePath)) {
    return `.${moduleName}`;
  }

  return sourcePath.replace(/\.py$/i, "").split("/").join(".");
}

function mergeMissingPythonImports(
  imports: Array<{ filePath: string; moduleName: string; names: string[] }>
): Array<{ filePath: string; modules: Array<{ moduleName: string; names: string[] }> }> {
  const modulesByFile = new Map<string, Map<string, Set<string>>>();

  for (const missingImport of imports) {
    let modules = modulesByFile.get(missingImport.filePath);
    if (!modules) {
      modules = new Map();
      modulesByFile.set(missingImport.filePath, modules);
    }

    let names = modules.get(missingImport.moduleName);
    if (!names) {
      names = new Set();
      modules.set(missingImport.moduleName, names);
    }

    for (const name of missingImport.names) {
      names.add(name);
    }
  }

  return [...modulesByFile].map(([filePath, modules]) => ({
    filePath,
    modules: [...modules].map(([moduleName, names]) => ({
      moduleName,
      names: [...names]
    }))
  }));
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

function addAttributesToClassSelector(html: string, className: string, attrNames: string[]): string {
  const countsByAttribute = new Map(attrNames.map((attrName) => [attrName, 0]));
  return html.replace(/<[a-z][a-z0-9-]*(?:\s[^<>]*)?>/gi, (tag, offset) => {
    if (!tagHasClass(tag, className)) {
      return tag;
    }

    let updatedTag = tag;
    for (const attrName of attrNames) {
      if (tagHasAttribute(updatedTag, attrName)) {
        continue;
      }

      const count = countsByAttribute.get(attrName) ?? 0;
      const value = inferAttributeValue(html, offset, className, count);
      countsByAttribute.set(attrName, count + 1);
      updatedTag = updatedTag.replace(/\s*\/?>$/, ` ${attrName}="${value}"$&`);
    }

    return updatedTag;
  });
}

function htmlClassNames(html: string): Set<string> {
  const classNames = new Set<string>();

  for (const match of html.matchAll(/<[^>]+>/g)) {
    for (const className of tagClassValues(match[0])) {
      classNames.add(className);
    }
  }

  return classNames;
}

function addClassesToSemanticMatches(html: string, classNames: string[]): string {
  const existingClassNames = htmlClassNames(html);
  const missingClassNames: Array<{ className: string; tokens: string[] }> = [];
  const seenMissingClassNames = new Set<string>();

  for (const className of classNames) {
    if (!existingClassNames.has(className) && !seenMissingClassNames.has(className)) {
      seenMissingClassNames.add(className);
      const tokens = classTokens(className);
      if (tokens.length > 0) {
        missingClassNames.push({ className, tokens });
      }
    }
  }

  if (missingClassNames.length === 0) {
    return html;
  }

  return html.replace(/<[a-z][a-z0-9-]*(?:\s[^<>]*)?>/gi, (tag) => {
    const tagTokens = new Set(tagClassValues(tag).flatMap(classTokens));
    let updatedTag = tag;
    for (const { className, tokens } of missingClassNames) {
      if (tokens.every((token) => tagTokens.has(token))) {
        updatedTag = addClassToTag(updatedTag, className);
        for (const token of tokens) {
          tagTokens.add(token);
        }
      }
    }

    return updatedTag;
  });
}

function applySelectorHookFallbacks(html: string, selectors: string[]): string {
  let completedHtml = html;
  const attributesByClass = new Map<string, string[]>();
  const missingClasses: string[] = [];

  for (const selector of selectors) {
    const classAttrMatch = selector.match(/^\.([a-zA-Z0-9_-]+)\[([a-zA-Z0-9_-]+)\]$/);
    if (classAttrMatch) {
      const attrNames = attributesByClass.get(classAttrMatch[1]);
      if (attrNames) {
        attrNames.push(classAttrMatch[2]);
      } else {
        attributesByClass.set(classAttrMatch[1], [classAttrMatch[2]]);
      }
      missingClasses.push(classAttrMatch[1]);
      continue;
    }

    const classMatch = selector.match(/^\.([a-zA-Z0-9_-]+)$/);
    if (classMatch) {
      missingClasses.push(classMatch[1]);
    }
  }

  completedHtml = addClassesToSemanticMatches(completedHtml, missingClasses);

  for (const [className, attrNames] of attributesByClass) {
    completedHtml = attrNames.length === 1
      ? addAttributeToClassSelector(completedHtml, className, attrNames[0])
      : addAttributesToClassSelector(completedHtml, className, attrNames);
  }

  return completedHtml;
}

function buildModalHookFallback(ids: string[], selectors: string[], html: string): string {
  const modalIds = ids.filter((id) =>
    /modal|overlay|dialog|review|product|graphic|image|visual|hero|title|desc|close|eyebrow|kicker|label/i.test(id) &&
    !htmlHasId(html, id)
  );
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
  const graphicId = modalIds.find((id) => /graphic|image|visual|hero/i.test(id));
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

  const stylePath = cachedFilePathByName(repoContext.fileTree, "styles.css");
  if (!stylePath) {
    return changes;
  }

  const existingStyleChange = changes.find((change) => change.filePath === stylePath);
  const originalContent = existingStyleChange?.originalContent ??
    await readFile(join(repoContext.localPath, stylePath), "utf8").catch(() => "");
  const baseContent = existingStyleChange?.modifiedContent ?? originalContent;
  const lowerBaseContent = baseContent.toLowerCase();
  const stylesToAdd = missingTokens
    .filter((token) => !lowerBaseContent.includes(token))
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

  const completedChanges = createChangeUpdater(changes);
  const resolvedHtmlPaths = new Map<string, string | null>();
  const assetPathsByHtmlPath = new Map<string, string[]>();

  for (const { assetPath, htmlPath } of unlinkedAssets) {
    let resolvedHtmlPath = resolvedHtmlPaths.get(htmlPath);
    if (resolvedHtmlPath === undefined) {
      resolvedHtmlPath = findHtmlInsertTarget(repoContext.fileTree, htmlPath);
      resolvedHtmlPaths.set(htmlPath, resolvedHtmlPath);
    }

    if (!resolvedHtmlPath) {
      continue;
    }

    const assetPaths = assetPathsByHtmlPath.get(resolvedHtmlPath);
    if (assetPaths) {
      assetPaths.push(assetPath);
    } else {
      assetPathsByHtmlPath.set(resolvedHtmlPath, [assetPath]);
    }
  }

  for (const [resolvedHtmlPath, assetPaths] of assetPathsByHtmlPath) {
    const existingHtmlChange = findChange(completedChanges, resolvedHtmlPath);
    const originalContent = existingHtmlChange?.originalContent ??
      await readFile(join(repoContext.localPath, resolvedHtmlPath), "utf8").catch(() => "");
    const baseContent = existingHtmlChange?.modifiedContent ?? originalContent;
    const modifiedContent = insertAssetTags(baseContent, assetPaths);
    if (modifiedContent === baseContent) {
      continue;
    }

    if (existingHtmlChange) {
      updateChangesForPath(
        completedChanges,
        resolvedHtmlPath,
        (change) => ({
          ...change,
          modifiedContent,
          explanation: `${change.explanation} ${assetLinkExplanation(assetPaths)}`
        })
      );
      continue;
    }

    appendChange(completedChanges, {
      filePath: resolvedHtmlPath,
      originalContent,
      modifiedContent,
      explanation: assetLinkExplanation(assetPaths)
    });
  }

  return completedChanges.changes;
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

  const htmlPath = cachedFilePathByName(repoContext.fileTree, "index.html");
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

  const completedChanges = createChangeUpdater(changes);
  for (const missingImportsForFile of mergeMissingPythonImports(missingImports)) {
    const existingChange = findChange(completedChanges, missingImportsForFile.filePath);
    const originalContent = existingChange?.originalContent ??
      await readFile(join(repoContext.localPath, missingImportsForFile.filePath), "utf8").catch(() => "");
    let modifiedContent = existingChange?.modifiedContent ?? originalContent;
    for (const { moduleName, names } of missingImportsForFile.modules) {
      const sourcePath = cachedFilePathByName(repoContext.fileTree, `${moduleName}.py`);
      modifiedContent = addPythonImport(
        modifiedContent,
        pythonImportSpecifier(missingImportsForFile.filePath, sourcePath, moduleName),
        names
      );
    }

    if (modifiedContent === (existingChange?.modifiedContent ?? originalContent)) {
      continue;
    }

    if (existingChange) {
      updateChangesForPath(
        completedChanges,
        missingImportsForFile.filePath,
        (change) => ({
          ...change,
          modifiedContent,
          explanation: `${change.explanation} Added missing Python import required by validation.`
        })
      );
      continue;
    }

    appendChange(completedChanges, {
      filePath: missingImportsForFile.filePath,
      originalContent,
      modifiedContent,
      explanation: "Added missing Python import required by validation."
    });
  }

  return completedChanges.changes;
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

const sensitiveProjectionFieldPattern = /(?:password|passwd|secret|token|credential|api_?key|private_?key|hash)/i;

interface ProjectionRepairCandidate {
  changeIndex: number;
  start: number;
  end: number;
  replacement: string;
}

function pythonFunctionRanges(content: string): Array<{ start: number; end: number; content: string }> {
  const starts = [...content.matchAll(/^(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/gm)].map((match) => match.index);
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? content.length;
    return { start, end, content: content.slice(start, end) };
  });
}

function addQualifiedFieldToProjection(projection: string, qualifiedField: string): string | null {
  if (new RegExp(`\\b${qualifiedField.replace(".", "\\.")}\\b`).test(projection)) {
    return null;
  }

  if (projection.includes("\n")) {
    const lines = projection.split("\n");
    const fieldLineIndexes = lines
      .map((line, index) => (/^\s*[A-Za-z_]\w*\.[A-Za-z_]\w*\s*,?\s*$/.test(line) ? index : -1))
      .filter((index) => index >= 0);
    if (fieldLineIndexes.length === 0) {
      return null;
    }
    const insertAt = fieldLineIndexes[fieldLineIndexes.length - 1];
    const indentation = lines[insertAt].match(/^\s*/)?.[0] ?? "";
    lines.splice(insertAt, 0, `${indentation}${qualifiedField},`);
    return lines.join("\n");
  }

  const fields = projection.split(",");
  if (fields.length < 2 || fields.some((field) => !/^\s*[A-Za-z_]\w*\.[A-Za-z_]\w*\s*$/.test(field))) {
    return null;
  }
  fields.splice(fields.length - 1, 0, ` ${qualifiedField}`);
  return fields.join(",");
}

export function applyVerificationFallbacks(
  changes: GeneratedChange[],
  verificationErrors: string[]
): GeneratedChange[] | null {
  const missingFields = new Set<string>();
  for (const error of verificationErrors) {
    for (const match of error.matchAll(/KeyError:\s*["']([A-Za-z_]\w*)["']/g)) {
      if (!sensitiveProjectionFieldPattern.test(match[1])) {
        missingFields.add(match[1]);
      }
    }
  }
  if (missingFields.size !== 1) {
    return null;
  }

  const field = [...missingFields][0];
  const candidates: ProjectionRepairCandidate[] = [];
  for (let changeIndex = 0; changeIndex < changes.length; changeIndex += 1) {
    const change = changes[changeIndex];
    if (!change.filePath.toLowerCase().endsWith(".py")) {
      continue;
    }

    const supportedAliases = new Set(
      [...change.originalContent.matchAll(new RegExp(`\\b([A-Za-z_]\\w*)\\.${field}\\b`, "g"))]
        .map((match) => match[1])
    );
    if (supportedAliases.size === 0) {
      continue;
    }

    for (const fn of pythonFunctionRanges(change.modifiedContent)) {
      if (!/return\s+\[\s*row_to_dict\s*\(/.test(fn.content)) {
        continue;
      }
      const selectPattern = /\bSELECT\b([\s\S]*?)\bFROM\b/gi;
      for (const selectMatch of fn.content.matchAll(selectPattern)) {
        const projection = selectMatch[1];
        for (const alias of supportedAliases) {
          const replacement = addQualifiedFieldToProjection(projection, `${alias}.${field}`);
          if (replacement === null) {
            continue;
          }
          const relativeStart = (selectMatch.index ?? 0) + selectMatch[0].indexOf(projection);
          candidates.push({
            changeIndex,
            start: fn.start + relativeStart,
            end: fn.start + relativeStart + projection.length,
            replacement
          });
        }
      }
    }
  }

  if (candidates.length !== 1) {
    return null;
  }

  const candidate = candidates[0];
  return changes.map((change, index) => index === candidate.changeIndex
    ? {
        ...change,
        modifiedContent:
          change.modifiedContent.slice(0, candidate.start) +
          candidate.replacement +
          change.modifiedContent.slice(candidate.end),
        explanation: `${change.explanation} Added the already-supported ${field} field to the unique public list projection after verification reported it missing.`
      }
    : change
  );
}

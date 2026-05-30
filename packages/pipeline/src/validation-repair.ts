import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { GeneratedChange, RepoContext } from "@mosaic/core";

const modalStyleValidationPattern =
  /Change for .+ adds modal UI hooks (?:\(([^)]+)\)|without matching selectors in ([^:]+): (.+)|but does not update ([^ ]+) with matching styles)/;
const unlinkedStaticAssetPattern = /New static asset ([^\s]+) is not linked from ([^\s]+)/;

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

export async function applyValidationFallbacks(
  changes: GeneratedChange[],
  repoContext: RepoContext,
  validationErrors: string[]
): Promise<GeneratedChange[]> {
  const withStyles = await completeMissingModalStyles(changes, repoContext, validationErrors);
  return completeUnlinkedStaticAssets(withStyles, repoContext, validationErrors);
}

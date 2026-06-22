import type { RelevantFile } from "@mosaic/core";

const importantRootFilePattern =
  /^(?:README|CONTRIBUTING|AGENTS|ARCHITECTURE|package|pnpm-workspace|tsconfig|jsconfig|vite\.config|vitest\.config|jest\.config|pyproject|requirements|setup|go\.mod|Cargo)\b/i;
const lowValueTreePathPattern =
  /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|dist|build|coverage|fixtures?\/.*\.(?:json|html|txt)|snapshots?\/)/i;
const treeStopWords = new Set([
  "about",
  "after",
  "again",
  "being",
  "change",
  "could",
  "files",
  "issue",
  "make",
  "mosaic",
  "request",
  "should",
  "there",
  "these",
  "thing",
  "those",
  "update",
  "where",
  "which",
  "while",
  "would"
]);

export interface PromptTreeOptions {
  maxPaths: number;
  summary?: string;
  rawContent?: string;
  relevantPaths?: string[];
  planPaths?: string[];
  changedPaths?: string[];
  validationErrors?: string[];
}

export interface PromptTree {
  paths: string[];
  omittedCount: number;
}

interface TreeScoreContext {
  options: PromptTreeOptions;
  terms: string[];
  directPathSet: Set<string>;
  directAncestorSet: Set<string>;
  directDirectories: string[];
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\//, "").trim();
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function pathAncestors(path: string): string[] {
  const parts = dirname(path).split("/").filter(Boolean);
  const ancestors: string[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    ancestors.push(parts.slice(0, index + 1).join("/"));
  }

  return ancestors;
}

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? [])]
    .filter((term) => !treeStopWords.has(term))
    .slice(0, 40);
}

function isSameOrChildPath(parentDir: string, candidatePath: string): boolean {
  if (parentDir.length === 0) {
    return !candidatePath.includes("/");
  }

  return candidatePath === parentDir || candidatePath.startsWith(`${parentDir}/`);
}

function cappedTermMatches(text: string, terms: string[], cap: number): number {
  let matches = 0;

  for (const term of terms) {
    if (text.includes(term)) {
      matches += 1;
      if (matches >= cap) {
        return cap;
      }
    }
  }

  return matches;
}

function buildTreeScoreContext(options: PromptTreeOptions, terms: string[]): TreeScoreContext {
  const directPaths = [
    ...(options.relevantPaths ?? []),
    ...(options.planPaths ?? []),
    ...(options.changedPaths ?? [])
  ].map(normalizePath);
  const directAncestorSet = new Set<string>();

  for (const directPath of directPaths) {
    for (const ancestor of pathAncestors(directPath)) {
      directAncestorSet.add(ancestor);
    }
  }

  return {
    options,
    terms,
    directPathSet: new Set(directPaths),
    directAncestorSet,
    directDirectories: directPaths.map(dirname)
  };
}

function scoreTreePath(path: string, context: TreeScoreContext): number {
  const { options, terms, directPathSet, directAncestorSet, directDirectories } = context;
  const normalized = normalizePath(path);
  const lowerPath = normalized.toLowerCase();
  let score = 0;

  if (directPathSet.has(normalized)) {
    score += 100;
  }

  if (directAncestorSet.has(normalized)) {
    score += 80;
  }

  if (directDirectories.some((directory) => isSameOrChildPath(directory, normalized))) {
    score += 35;
  }

  if (!normalized.includes("/")) {
    score += 20;
  }

  if (importantRootFilePattern.test(normalized)) {
    score += 28;
  }

  if (/(?:^|\/)(?:docs?|issues?|test|tests|spec|specs|__tests__|reported)(?:\/|$)/i.test(normalized)) {
    score += 8;
  }

  const termMatches = cappedTermMatches(lowerPath, terms, 6);
  score += Math.min(30, termMatches * 5);

  if (lowValueTreePathPattern.test(normalized)) {
    score -= 30;
  }

  return score;
}

export function compactPromptFileTree(fileTree: string[], options: PromptTreeOptions): PromptTree {
  const normalizedTree = [...new Set(fileTree.map(normalizePath).filter(Boolean))];
  if (normalizedTree.length <= options.maxPaths) {
    return { paths: normalizedTree, omittedCount: 0 };
  }

  const terms = tokenize([
    options.summary,
    options.rawContent,
    ...(options.relevantPaths ?? []),
    ...(options.planPaths ?? []),
    ...(options.changedPaths ?? []),
    ...(options.validationErrors ?? [])
  ].filter(Boolean).join("\n"));
  const scoreContext = buildTreeScoreContext(options, terms);
  const ranked = normalizedTree
    .map((path, index) => ({ path, index, score: scoreTreePath(path, scoreContext) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = new Set(ranked.slice(0, options.maxPaths).map((item) => item.path));
  const normalizedTreeSet = new Set(normalizedTree);

  for (const path of [
    ...(options.relevantPaths ?? []),
    ...(options.planPaths ?? []),
    ...(options.changedPaths ?? [])
  ].map(normalizePath)) {
    if (normalizedTreeSet.has(path)) {
      selected.add(path);
    }

    for (const ancestor of pathAncestors(path)) {
      if (normalizedTreeSet.has(ancestor)) {
        selected.add(ancestor);
      }
    }
  }

  const paths = normalizedTree.filter((path) => selected.has(path)).slice(0, options.maxPaths);
  return {
    paths,
    omittedCount: normalizedTree.length - paths.length
  };
}

export function formatPromptFileTree(fileTree: string[], options: PromptTreeOptions): string {
  const compacted = compactPromptFileTree(fileTree, options);
  const note = compacted.omittedCount > 0
    ? `\n[MOSAIC CONTEXT NOTE: ${compacted.omittedCount} lower-relevance repository path(s) omitted from this prompt. Loaded file contents below are authoritative.]`
    : "";

  return `${compacted.paths.join("\n")}${note}`;
}

export function promptFilePaths(files: Array<Pick<RelevantFile, "path">>): string[] {
  return files.map((file) => file.path);
}

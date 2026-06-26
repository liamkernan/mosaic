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
  directDirectorySet: Set<string>;
}

interface RankedPath {
  path: string;
  index: number;
  score: number;
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

function addPathAncestors(path: string, ancestors: Set<string>): void {
  const end = path.lastIndexOf("/");
  if (end < 0) {
    return;
  }

  let ancestor = "";
  let segmentStart = 0;
  for (let index = 0; index <= end; index += 1) {
    if (index !== end && path[index] !== "/") {
      continue;
    }

    if (index > segmentStart) {
      const segment = path.slice(segmentStart, index);
      ancestor = ancestor.length === 0 ? segment : `${ancestor}/${segment}`;
      ancestors.add(ancestor);
    }

    segmentStart = index + 1;
  }
}

function addDirectPaths(
  paths: string[] | undefined,
  directPathSet: Set<string>,
  directAncestorSet: Set<string>,
  directDirectorySet: Set<string>
): void {
  for (const rawPath of paths ?? []) {
    const directPath = normalizePath(rawPath);
    directPathSet.add(directPath);
    const slashIndex = directPath.lastIndexOf("/");
    directDirectorySet.add(slashIndex >= 0 ? directPath.slice(0, slashIndex) : "");
    addPathAncestors(directPath, directAncestorSet);
  }
}

function tokenize(text: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();

  for (const match of text.toLowerCase().matchAll(/[a-z0-9_]{4,}/g)) {
    const term = match[0];
    if (treeStopWords.has(term) || seen.has(term)) {
      continue;
    }

    seen.add(term);
    terms.push(term);
    if (terms.length >= 40) {
      break;
    }
  }

  return terms;
}

function hasDirectDirectoryMatch(candidatePath: string, context: TreeScoreContext): boolean {
  const { directDirectorySet } = context;
  if (directDirectorySet.has("") && !candidatePath.includes("/")) {
    return true;
  }

  if (directDirectorySet.has(candidatePath)) {
    return true;
  }

  for (let index = candidatePath.indexOf("/"); index >= 0; index = candidatePath.indexOf("/", index + 1)) {
    if (directDirectorySet.has(candidatePath.slice(0, index))) {
      return true;
    }
  }

  return false;
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
  const directPathSet = new Set<string>();
  const directAncestorSet = new Set<string>();
  const directDirectorySet = new Set<string>();

  addDirectPaths(options.relevantPaths, directPathSet, directAncestorSet, directDirectorySet);
  addDirectPaths(options.planPaths, directPathSet, directAncestorSet, directDirectorySet);
  addDirectPaths(options.changedPaths, directPathSet, directAncestorSet, directDirectorySet);

  return {
    options,
    terms,
    directPathSet,
    directAncestorSet,
    directDirectorySet
  };
}

function scoreTreePath(path: string, context: TreeScoreContext): number {
  const { terms, directPathSet, directAncestorSet } = context;
  const normalized = path;
  const lowerPath = normalized.toLowerCase();
  let score = 0;

  if (directPathSet.has(normalized)) {
    score += 100;
  }

  if (directAncestorSet.has(normalized)) {
    score += 80;
  }

  if (hasDirectDirectoryMatch(normalized, context)) {
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

function isBetterRank(left: RankedPath, right: RankedPath): boolean {
  return left.score > right.score || (left.score === right.score && left.index < right.index);
}

function isWorseRank(left: RankedPath, right: RankedPath): boolean {
  return left.score < right.score || (left.score === right.score && left.index > right.index);
}

function siftRankDown(heap: RankedPath[], startIndex: number): void {
  let index = startIndex;

  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;

    if (left < heap.length && isWorseRank(heap[left], heap[worst])) {
      worst = left;
    }

    if (right < heap.length && isWorseRank(heap[right], heap[worst])) {
      worst = right;
    }

    if (worst === index) {
      return;
    }

    [heap[index], heap[worst]] = [heap[worst], heap[index]];
    index = worst;
  }
}

function siftRankUp(heap: RankedPath[], startIndex: number): void {
  let index = startIndex;

  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!isWorseRank(heap[index], heap[parent])) {
      return;
    }

    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function selectTopRankedPaths(paths: string[], context: TreeScoreContext, limit: number): RankedPath[] {
  const heap: RankedPath[] = [];

  for (let index = 0; index < paths.length; index += 1) {
    const candidate = {
      path: paths[index],
      index,
      score: scoreTreePath(paths[index], context)
    };

    if (heap.length < limit) {
      heap.push(candidate);
      siftRankUp(heap, heap.length - 1);
      continue;
    }

    if (isBetterRank(candidate, heap[0])) {
      heap[0] = candidate;
      siftRankDown(heap, 0);
    }
  }

  return heap;
}

export function compactPromptFileTree(fileTree: string[], options: PromptTreeOptions): PromptTree {
  const normalizedTreeSet = new Set<string>();
  for (const path of fileTree) {
    const normalized = normalizePath(path);
    if (normalized.length > 0) {
      normalizedTreeSet.add(normalized);
    }
  }

  const normalizedTree = [...normalizedTreeSet];
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
  const selected = new Set(selectTopRankedPaths(normalizedTree, scoreContext, options.maxPaths).map((item) => item.path));

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

export function formatPromptFileBlocks(files: Array<Pick<RelevantFile, "path" | "content">>): string {
  let output = "";

  for (const file of files) {
    const block = `--- ${file.path} ---\n${file.content}\n--- END ${file.path} ---`;
    output = output.length === 0 ? block : `${output}\n\n${block}`;
  }

  return output;
}

export function formatPromptFileBlocksWithReasons(files: RelevantFile[]): string {
  let output = "";

  for (const file of files) {
    const block = `--- ${file.path} ---\nReason: ${file.reason}\n${file.content}\n--- END ${file.path} ---`;
    output = output.length === 0 ? block : `${output}\n\n${block}`;
  }

  return output;
}

import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { getEnv, logger, type ClassifiedFeedback, type FileNode, type RelevantFile, type RepoContext } from "@mosaic/core";
import { getInstallationToken, getOctokit, resolveInstallationId } from "@mosaic/github-app";
import { simpleGit } from "simple-git";

import { resolveExistingRepoPath } from "./repo-paths.js";

const ignoredNames = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".next", "vendor"]);
const flattenedFileTreeCache = new WeakMap<FileNode[], string[]>();
const fileSizeCache = new WeakMap<FileNode[], Map<string, number>>();
const largeFileTruncationBytes = 100 * 1024;
const largeFileTruncationLines = 200;
const referenceFilePattern = /\.(?:md|mdx|rst|txt|ya?ml|json|py|[cm]?[jt]sx?|html|css)$/i;
const referenceDirectoryPattern = /(?:^|\/)(?:test|tests|spec|specs|__tests__|reported)(?:\/|$)/;
const repoReferenceNames = new Set([
  "readme.md",
  "readme.mdx",
  "contributing.md",
  "agents.md",
  "coding-standards.md",
  "architecture.md"
]);
const stopWords = new Set([
  "about",
  "above",
  "after",
  "again",
  "because",
  "before",
  "being",
  "could",
  "current",
  "existing",
  "issue",
  "mosaic",
  "request",
  "requests",
  "right",
  "should",
  "source",
  "support",
  "there",
  "these",
  "thing",
  "those",
  "where",
  "which",
  "while",
  "would"
]);

function detectLanguage(filePath: string): string | undefined {
  const dotIndex = filePath.lastIndexOf(".");
  const extension = dotIndex >= 0 ? filePath.slice(dotIndex + 1).toLowerCase() : undefined;
  const languageMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    yml: "yaml",
    yaml: "yaml",
    py: "python",
    rb: "ruby",
    go: "go"
  };

  return extension ? languageMap[extension] : undefined;
}

function isIgnoredName(name: string): boolean {
  return ignoredNames.has(name) || name.startsWith(".");
}

async function buildFileTree(rootPath: string, currentPath = ""): Promise<FileNode[]> {
  const directoryPath = currentPath ? join(rootPath, currentPath) : rootPath;
  const entries = await readdir(directoryPath, { withFileTypes: true });

  const nodes = await Promise.all(entries.filter((entry) => !isIgnoredName(entry.name)).map(async (entry): Promise<FileNode> => {
    const relativePath = currentPath ? join(currentPath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      return {
        path: relativePath,
        type: "directory",
        children: await buildFileTree(rootPath, relativePath)
      };
    }

    return {
      path: relativePath,
      type: "file",
      language: detectLanguage(relativePath)
    };
  }));

  return nodes.sort((left, right) => left.path.localeCompare(right.path));
}

async function cloneOrUpdateRepo(repoFullName: string, localPath: string, defaultBranch: string, installationId: number): Promise<void> {
  const parentDirectory = dirname(localPath);
  await mkdir(parentDirectory, { recursive: true });

  const token = await getInstallationToken(installationId);
  const remoteUrl = `https://x-access-token:${encodeURIComponent(token)}@github.com/${repoFullName}.git`;

  const git = simpleGit();
  try {
    await stat(join(localPath, ".git"));
    await simpleGit(localPath).pull("origin", defaultBranch);
  } catch {
    await git.clone(remoteUrl, localPath, ["--depth", "1", "--branch", defaultBranch]);
  }
}

function appendFileTreePaths(nodes: FileNode[], paths: string[]): void {
  for (const node of nodes) {
    paths.push(node.path);
    if (node.type === "directory") {
      appendFileTreePaths(node.children ?? [], paths);
    }
  }
}

function flattenFileTree(nodes: FileNode[]): string[] {
  const paths: string[] = [];
  appendFileTreePaths(nodes, paths);
  return paths;
}

function truncateLargeFile(content: string): string {
  let newlineIndex = -1;
  for (let line = 0; line < largeFileTruncationLines; line += 1) {
    newlineIndex = content.indexOf("\n", newlineIndex + 1);
    if (newlineIndex === -1) {
      return content;
    }
  }

  return content.slice(0, newlineIndex);
}

async function readLargeFilePrefix(filePath: string): Promise<string> {
  let content = "";
  let newlineCount = 0;
  const stream = createReadStream(filePath, { encoding: "utf8" });

  try {
    for await (const chunk of stream) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let chunkStart = 0;

      while (true) {
        const newlineIndex = text.indexOf("\n", chunkStart);
        if (newlineIndex === -1) {
          content += text.slice(chunkStart);
          break;
        }

        newlineCount += 1;
        if (newlineCount >= largeFileTruncationLines) {
          content += text.slice(chunkStart, newlineIndex);
          stream.destroy();
          return content;
        }

        content += text.slice(chunkStart, newlineIndex + 1);
        chunkStart = newlineIndex + 1;
      }
    }
  } finally {
    stream.destroy();
  }

  return truncateLargeFile(content);
}

function buildFileSizeMap(nodes: FileNode[], sizes = new Map<string, number>()): Map<string, number> {
  for (const node of nodes) {
    if (node.type === "directory") {
      buildFileSizeMap(node.children ?? [], sizes);
      continue;
    }

    if (node.sizeBytes !== undefined) {
      sizes.set(node.path, node.sizeBytes);
    }
  }

  return sizes;
}

function knownFileSize(context: RepoContext, filePath: string): number | undefined {
  let sizes = fileSizeCache.get(context.fileTree);
  if (!sizes) {
    sizes = buildFileSizeMap(context.fileTree);
    fileSizeCache.set(context.fileTree, sizes);
  }

  return sizes.get(filePath);
}

function tokenizeForSearch(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .match(/[a-z0-9_]{4,}/g) ?? [];

  return [...new Set(tokens)].filter((token) => !stopWords.has(token));
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

function issueNumberPattern(issueNumber: number): RegExp {
  return new RegExp(`^(?:0*)${issueNumber}(?:[^0-9]|$)`);
}

function referencedIssueNumber(name: string): number | undefined {
  const match = name.match(/^(?:(?:test|issue)[_-])?0*(\d+)(?:[^0-9]|$)/i);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function isLikelyReferencePath(lowerPath: string, name: string): boolean {
  return repoReferenceNames.has(name) ||
    lowerPath.startsWith("docs/") ||
    lowerPath.startsWith("issues/") ||
    lowerPath.includes("/docs/") ||
    lowerPath.includes("/issues/") ||
    referenceDirectoryPattern.test(lowerPath);
}

function scoreReferencePath(path: string, lowerPath: string, name: string, terms: string[], issuePattern?: RegExp): number {
  if (!referenceFilePattern.test(path)) {
    return 0;
  }

  let score = 0;

  if (repoReferenceNames.has(name)) {
    score += 8;
  }

  if (lowerPath.startsWith("docs/") || lowerPath.includes("/docs/")) {
    score += 4;
  }

  if (lowerPath.startsWith("issues/") || lowerPath.includes("/issues/")) {
    score += 6;
  }

  if (referenceDirectoryPattern.test(lowerPath)) {
    score += 4;
  }

  if (issuePattern?.test(name)) {
    score += 24;
  }

  const pathTermMatches = cappedTermMatches(lowerPath, terms, 5);
  score += Math.min(10, pathTermMatches * 2);

  return score;
}

function rankReferencePaths(fileTree: string[], terms: string[], issuePattern?: RegExp): Array<{ path: string; name: string; score: number }> {
  const rankedPaths: Array<{ path: string; name: string; score: number }> = [];

  for (const path of fileTree) {
    if (!referenceFilePattern.test(path)) {
      continue;
    }

    const lowerPath = path.toLowerCase();
    const name = basename(lowerPath);
    if (!isLikelyReferencePath(lowerPath, name)) {
      continue;
    }

    const score = scoreReferencePath(path, lowerPath, name, terms, issuePattern);
    if (score > 0) {
      rankedPaths.push({ path, name, score });
    }
  }

  return rankedPaths.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

function referenceReason(path: string, issueNumber?: number, issuePattern?: RegExp): string {
  const lowerPath = path.toLowerCase();
  const name = basename(lowerPath);

  if (issueNumber && issuePattern?.test(name)) {
    return `Repository issue/spec reference for promoted issue #${issueNumber}`;
  }

  if (referenceDirectoryPattern.test(lowerPath)) {
    return "Repository test reference for expected behavior and coverage pattern";
  }

  if (lowerPath.startsWith("issues/") || lowerPath.includes("/issues/")) {
    return "Repository issue/spec reference for acceptance criteria";
  }

  if (repoReferenceNames.has(name) || lowerPath.startsWith("docs/") || lowerPath.includes("/docs/")) {
    return "Repository documentation reference for conventions and requirements";
  }

  return "Repository reference matched the feedback terms";
}

async function readContainedRepoFile(
  context: RepoContext,
  filePath: string,
  missingMessage: string
): Promise<{ path: string; content: string; sizeBytes: number } | null> {
  try {
    const resolvedPath = await resolveExistingRepoPath(context.localPath, filePath);
    if (!resolvedPath) {
      logger.warn({ repo: context.fullName, filePath }, "Rejected repository file path outside the repo root");
      return null;
    }

    const expectedSize = knownFileSize(context, resolvedPath.repoPath);
    if (expectedSize !== undefined && expectedSize > largeFileTruncationBytes) {
      const content = await readLargeFilePrefix(resolvedPath.absolutePath);

      return {
        path: resolvedPath.repoPath,
        content,
        sizeBytes: expectedSize
      };
    }

    if (expectedSize !== undefined) {
      return {
        path: resolvedPath.repoPath,
        content: await readFile(resolvedPath.absolutePath, "utf8"),
        sizeBytes: expectedSize
      };
    }

    const fileStat = await stat(resolvedPath.absolutePath);
    if (fileStat.size > largeFileTruncationBytes) {
      const content = await readLargeFilePrefix(resolvedPath.absolutePath);

      return {
        path: resolvedPath.repoPath,
        content,
        sizeBytes: fileStat.size
      };
    }

    return {
      path: resolvedPath.repoPath,
      content: await readFile(resolvedPath.absolutePath, "utf8"),
      sizeBytes: fileStat.size
    };
  } catch {
    logger.warn({ repo: context.fullName, filePath }, missingMessage);
    return null;
  }
}

export class RepoIndexer {
  async getContext(repoFullName: string): Promise<RepoContext> {
    const installationId = await resolveInstallationId(repoFullName);
    const octokit = await getOctokit(installationId);
    const [owner, repo] = repoFullName.split("/");
    const repoMetadata = await octokit.rest.repos.get({
      owner,
      repo
    });
    const defaultBranch = repoMetadata.data.default_branch;
    const localPath = join(getEnv().REPO_CACHE_DIR, owner, repo);

    await cloneOrUpdateRepo(repoFullName, localPath, defaultBranch, installationId);
    const fileTree = await buildFileTree(localPath);

    return {
      fullName: repoFullName,
      defaultBranch,
      localPath,
      fileTree,
      installationId
    };
  }

  async getTopLevelFileTree(repoFullName: string): Promise<string[]> {
    const context = await this.getContext(repoFullName);
    return context.fileTree.map((node) => node.path);
  }

  async findRelevantFiles(context: RepoContext, classified: ClassifiedFeedback): Promise<RelevantFile[]> {
    const loadedFiles = await Promise.all(classified.relevantFiles.map(async (filePath, index) => {
      const loadedFile = await readContainedRepoFile(
        context,
        filePath,
        "Classifier suggested a file that does not exist"
      );

      if (loadedFile) {
        return {
          path: loadedFile.path,
          content: loadedFile.content,
          reason: `Classifier ranked this file as #${index + 1} relevant`
        };
      }

      return null;
    }));
    const files = loadedFiles.filter((file): file is RelevantFile => Boolean(file));

    let totalBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
    while (totalBytes > 50 * 1024 && files.length > 1) {
      const removed = files.pop();
      totalBytes -= Buffer.byteLength(removed?.content ?? "");
    }

    return files;
  }

  async readFiles(context: RepoContext, requestedFiles: Array<{ path: string; reason: string }>): Promise<RelevantFile[]> {
    const loadedFiles = await Promise.all(requestedFiles.map(async (requestedFile) => {
      const loadedFile = await readContainedRepoFile(
        context,
        requestedFile.path,
        "Implementation plan requested a file that does not exist"
      );

      if (loadedFile) {
        return {
          path: loadedFile.path,
          content: loadedFile.content,
          reason: requestedFile.reason
        };
      }

      return null;
    }));

    const files: RelevantFile[] = [];
    for (const file of loadedFiles) {
      if (file) {
        files.push(file);
      }
    }

    return files;
  }

  async findRepositoryReferenceFiles(
    context: RepoContext,
    classified: ClassifiedFeedback,
    options: { issueNumber?: number } = {}
  ): Promise<RelevantFile[]> {
    const fileTree = this.fileTreeToPaths(context);
    const terms = tokenizeForSearch(`${classified.rawContent}\n${classified.summary}`);
    const issuePattern = options.issueNumber ? issueNumberPattern(options.issueNumber) : undefined;
    const rankedPaths = rankReferencePaths(fileTree, terms, issuePattern);

    const references: RelevantFile[] = [];
    let totalBytes = 0;
    const maxReferences = 8;
    const maxTotalBytes = 64 * 1024;

    for (const candidate of rankedPaths) {
      if (references.length >= maxReferences || totalBytes >= maxTotalBytes) {
        break;
      }

      const candidateIssueNumber = referencedIssueNumber(candidate.name);
      if (options.issueNumber !== undefined &&
          candidateIssueNumber !== undefined &&
          candidateIssueNumber !== options.issueNumber) {
        continue;
      }

      const loadedFile = await readContainedRepoFile(
        context,
        candidate.path,
        "Repository reference file could not be read"
      );

      if (loadedFile) {
        const exactIssueMatch = issuePattern?.test(candidate.name) ?? false;
        const contentMatchRequired = !exactIssueMatch && !repoReferenceNames.has(candidate.name) && candidate.score < 10;
        if (contentMatchRequired) {
          const lowerContent = loadedFile.content.toLowerCase();
          if (!terms.some((term) => lowerContent.includes(term))) {
            continue;
          }
        }

        totalBytes += Buffer.byteLength(loadedFile.content);
        references.push({
          path: loadedFile.path,
          content: loadedFile.content,
          reason: referenceReason(candidate.path, options.issueNumber, issuePattern)
        });
      }
    }

    return references;
  }

  fileTreeToPaths(context: RepoContext): string[] {
    const cachedPaths = flattenedFileTreeCache.get(context.fileTree);
    if (cachedPaths) {
      return [...cachedPaths];
    }

    const paths = flattenFileTree(context.fileTree);
    flattenedFileTreeCache.set(context.fileTree, paths);
    return [...paths];
  }
}

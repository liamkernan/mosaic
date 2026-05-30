import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { getEnv, logger, type ClassifiedFeedback, type FileNode, type RelevantFile, type RepoContext } from "@mosaic/core";
import { getInstallationToken, getOctokit, resolveInstallationId } from "@mosaic/github-app";
import { simpleGit } from "simple-git";

const ignoredNames = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".next", "vendor"]);
const referenceFilePattern = /\.(?:md|mdx|rst|txt|ya?ml|json|py|[cm]?[jt]sx?|html|css)$/i;
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
  "right",
  "should",
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
  const extension = filePath.split(".").pop()?.toLowerCase();
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
  const nodes: FileNode[] = [];

  for (const entry of entries) {
    if (isIgnoredName(entry.name)) {
      continue;
    }

    const relativePath = currentPath ? join(currentPath, entry.name) : entry.name;
    const absolutePath = join(rootPath, relativePath);

    if (entry.isDirectory()) {
      nodes.push({
        path: relativePath,
        type: "directory",
        children: await buildFileTree(rootPath, relativePath)
      });
      continue;
    }

    const fileStat = await stat(absolutePath);
    nodes.push({
      path: relativePath,
      type: "file",
      language: detectLanguage(relativePath),
      sizeBytes: fileStat.size
    });
  }

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

function flattenFileTree(nodes: FileNode[]): string[] {
  return nodes.flatMap((node) => {
    if (node.type === "directory") {
      return [node.path, ...flattenFileTree(node.children ?? [])];
    }

    return [node.path];
  });
}

function truncateLargeFile(content: string): string {
  return content.split("\n").slice(0, 200).join("\n");
}

function tokenizeForSearch(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .match(/[a-z0-9_]{4,}/g) ?? [];

  return [...new Set(tokens)].filter((token) => !stopWords.has(token));
}

function issueNumberPattern(issueNumber: number): RegExp {
  return new RegExp(`^(?:0*)${issueNumber}(?:[^0-9]|$)`);
}

function isLikelyReferencePath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  const name = basename(lowerPath);

  return repoReferenceNames.has(name) ||
    lowerPath.startsWith("docs/") ||
    lowerPath.startsWith("issues/") ||
    lowerPath.includes("/docs/") ||
    lowerPath.includes("/issues/") ||
    /(?:^|\/)(?:test|tests|spec|specs|__tests__|reported)(?:\/|$)/.test(lowerPath);
}

function scoreReferencePath(path: string, terms: string[], issueNumber?: number): number {
  if (!referenceFilePattern.test(path)) {
    return 0;
  }

  const lowerPath = path.toLowerCase();
  const name = basename(lowerPath);
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

  if (/(?:^|\/)(?:test|tests|spec|specs|__tests__|reported)(?:\/|$)/.test(lowerPath)) {
    score += 4;
  }

  if (issueNumber && issueNumberPattern(issueNumber).test(name)) {
    score += 24;
  }

  const pathTermMatches = terms.filter((term) => lowerPath.includes(term)).length;
  score += Math.min(10, pathTermMatches * 2);

  return score;
}

function referenceReason(path: string, issueNumber?: number): string {
  const lowerPath = path.toLowerCase();
  const name = basename(lowerPath);

  if (issueNumber && issueNumberPattern(issueNumber).test(name)) {
    return `Repository issue/spec reference for promoted issue #${issueNumber}`;
  }

  if (/(?:^|\/)(?:test|tests|spec|specs|__tests__|reported)(?:\/|$)/.test(lowerPath)) {
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
    const files: RelevantFile[] = [];

    for (const [index, filePath] of classified.relevantFiles.entries()) {
      const absolutePath = join(context.localPath, filePath);

      try {
        const fileStat = await stat(absolutePath);
        let content = await readFile(absolutePath, "utf8");
        if (fileStat.size > 100 * 1024) {
          content = truncateLargeFile(content);
        }

        files.push({
          path: filePath,
          content,
          reason: `Classifier ranked this file as #${index + 1} relevant`
        });
      } catch {
        logger.warn({ repo: context.fullName, filePath }, "Classifier suggested a file that does not exist");
      }
    }

    let totalBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
    while (totalBytes > 50 * 1024 && files.length > 1) {
      const removed = files.pop();
      totalBytes -= Buffer.byteLength(removed?.content ?? "");
    }

    return files;
  }

  async readFiles(context: RepoContext, requestedFiles: Array<{ path: string; reason: string }>): Promise<RelevantFile[]> {
    const files: RelevantFile[] = [];

    for (const requestedFile of requestedFiles) {
      const absolutePath = join(context.localPath, requestedFile.path);

      try {
        const fileStat = await stat(absolutePath);
        let content = await readFile(absolutePath, "utf8");
        if (fileStat.size > 100 * 1024) {
          content = truncateLargeFile(content);
        }

        files.push({
          path: requestedFile.path,
          content,
          reason: requestedFile.reason
        });
      } catch {
        logger.warn({ repo: context.fullName, filePath: requestedFile.path }, "Implementation plan requested a file that does not exist");
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
    const rankedPaths = fileTree
      .filter(isLikelyReferencePath)
      .map((path) => ({
        path,
        score: scoreReferencePath(path, terms, options.issueNumber)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

    const references: RelevantFile[] = [];
    let totalBytes = 0;
    const maxReferences = 8;
    const maxTotalBytes = 64 * 1024;

    for (const candidate of rankedPaths) {
      if (references.length >= maxReferences || totalBytes >= maxTotalBytes) {
        break;
      }

      const absolutePath = join(context.localPath, candidate.path);

      try {
        const fileStat = await stat(absolutePath);
        let content = await readFile(absolutePath, "utf8");
        if (fileStat.size > 100 * 1024) {
          content = truncateLargeFile(content);
        }

        const contentMatches = terms.filter((term) => content.toLowerCase().includes(term)).length;
        const exactIssueMatch = options.issueNumber
          ? issueNumberPattern(options.issueNumber).test(basename(candidate.path.toLowerCase()))
          : false;
        if (!exactIssueMatch && !repoReferenceNames.has(basename(candidate.path.toLowerCase())) && contentMatches === 0 && candidate.score < 10) {
          continue;
        }

        totalBytes += Buffer.byteLength(content);
        references.push({
          path: candidate.path,
          content,
          reason: referenceReason(candidate.path, options.issueNumber)
        });
      } catch {
        logger.warn({ repo: context.fullName, filePath: candidate.path }, "Repository reference file could not be read");
      }
    }

    return references;
  }

  fileTreeToPaths(context: RepoContext): string[] {
    return flattenFileTree(context.fileTree);
  }
}

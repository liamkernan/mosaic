import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getEnv, logger, type ClassifiedFeedback, type FileNode, type RelevantFile, type RepoContext } from "@feedbackbot/core";
import { getInstallationToken, getOctokit, resolveInstallationId } from "@feedbackbot/github-app";
import { simpleGit } from "simple-git";

const ignoredNames = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".next", "vendor"]);

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

  fileTreeToPaths(context: RepoContext): string[] {
    return flattenFileTree(context.fileTree);
  }
}

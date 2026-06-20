import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const windowsAbsolutePathPattern = /^[a-zA-Z]:[\\/]|^\\\\/;

export function normalizeRepoRelativePath(filePath: string): string | null {
  const rawPath = filePath.trim();
  const normalized = rawPath.replace(/\\/g, "/");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    windowsAbsolutePathPattern.test(rawPath) ||
    isAbsolute(rawPath)
  ) {
    return null;
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }

  return normalized;
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath.length === 0 || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function validateRepoRelativePath(filePath: string): string | null {
  return normalizeRepoRelativePath(filePath);
}

export async function resolveExistingRepoPath(repoRoot: string, filePath: string): Promise<{ absolutePath: string; repoPath: string } | null> {
  const repoPath = normalizeRepoRelativePath(filePath);
  if (!repoPath) {
    return null;
  }

  const rootRealPath = await realpath(repoRoot);
  const absolutePath = resolve(rootRealPath, repoPath);
  const targetRealPath = await realpath(absolutePath);
  if (!isWithinRoot(rootRealPath, targetRealPath)) {
    return null;
  }

  return {
    absolutePath: targetRealPath,
    repoPath
  };
}

export async function resolveRepoWritePath(repoRoot: string, filePath: string): Promise<{ absolutePath: string; repoPath: string } | null> {
  const repoPath = normalizeRepoRelativePath(filePath);
  if (!repoPath) {
    return null;
  }

  const rootRealPath = await realpath(repoRoot);
  const absolutePath = resolve(rootRealPath, repoPath);
  if (!isWithinRoot(rootRealPath, absolutePath)) {
    return null;
  }

  let currentPath = rootRealPath;
  const parentSegments = repoPath.split("/").slice(0, -1);
  for (const segment of parentSegments) {
    currentPath = join(currentPath, segment);

    try {
      const currentStat = await lstat(currentPath);
      if (currentStat.isSymbolicLink()) {
        const currentRealPath = await realpath(currentPath);
        if (!isWithinRoot(rootRealPath, currentRealPath)) {
          return null;
        }
      } else if (!currentStat.isDirectory()) {
        return null;
      }
    } catch {
      await mkdir(currentPath);
    }
  }

  const parentRealPath = await realpath(dirname(absolutePath));
  if (!isWithinRoot(rootRealPath, parentRealPath)) {
    return null;
  }

  return {
    absolutePath,
    repoPath
  };
}

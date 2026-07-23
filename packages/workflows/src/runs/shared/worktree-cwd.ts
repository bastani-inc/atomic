import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { GitWorktreeSetupResult } from "./worktree-types.js";

function relativePathWithin(root: string, candidate: string): string | undefined {
  const path = relative(root, candidate);
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) ? undefined : path;
}

function existingRealPathThroughAncestor(path: string, description: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync.native(existing), ...missing);
    } catch (error) {
      let existingEntry: ReturnType<typeof lstatSync> | undefined;
      try {
        existingEntry = lstatSync(existing);
      } catch {
        // Missing components are resolved through their nearest existing ancestor.
      }
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { readonly code?: unknown }).code)
        : undefined;
      const parent = dirname(existing);
      if (existingEntry?.isSymbolicLink() === true || (code !== "ENOENT" && code !== "ENOTDIR") || parent === existing) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`atomic-workflows: cannot resolve ${description} ${path}: ${message}`);
      }
      missing.unshift(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      existing = parent;
    }
  }
}

function existingRealPath(path: string, description: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`atomic-workflows: cannot resolve ${description} ${path}: ${message}`);
  }
}

export function resolveWorktreeStageCwd(
  cwd: string | undefined,
  setup: GitWorktreeSetupResult,
): string | undefined {
  const worktreeRoot = existingRealPath(setup.worktreeRoot, "gitWorktreeDir");
  const repositoryRoot = existingRealPath(setup.repositoryRoot, "invoking checkout");
  if (cwd === undefined || cwd.length === 0) return undefined;

  const absoluteInput = isAbsolute(cwd);
  const candidate = absoluteInput ? cwd : resolve(setup.cwd, cwd);
  if (!absoluteInput && relativePathWithin(setup.worktreeRoot, candidate) === undefined) {
    throw new Error(`atomic-workflows: relative cwd ${cwd} escapes gitWorktreeDir ${setup.worktreeRoot}; choose a cwd inside the worktree.`);
  }
  const candidateRealPath = existingRealPath(candidate, "cwd");
  const worktreeRelative = relativePathWithin(worktreeRoot, candidateRealPath);
  if (worktreeRelative !== undefined) return resolve(setup.worktreeRoot, worktreeRelative);
  if (!isAbsolute(cwd)) {
    throw new Error(`atomic-workflows: relative cwd ${cwd} escapes gitWorktreeDir ${setup.worktreeRoot}; choose a path that remains inside the selected worktree.`);
  }
  if (relativePathWithin(setup.worktreeRoot, candidate) !== undefined) {
    throw new Error(`atomic-workflows: cwd ${cwd} resolves outside gitWorktreeDir ${setup.worktreeRoot}; remove the escaping symlink or choose a cwd inside the worktree.`);
  }

  const repositoryRelative = absoluteInput
    ? relativePathWithin(repositoryRoot, candidateRealPath)
    : undefined;
  if (repositoryRelative === undefined) {
    throw new Error(`atomic-workflows: cwd ${cwd} is outside gitWorktreeDir ${setup.worktreeRoot}; use a cwd inside the invoking repository so Atomic can remap it, or omit cwd.`);
  }
  const mappedCwd = resolve(setup.worktreeRoot, repositoryRelative);
  const mappedRealPath = existingRealPath(mappedCwd, "remapped worktree cwd");
  if (relativePathWithin(worktreeRoot, mappedRealPath) === undefined) {
    throw new Error(`atomic-workflows: cwd ${cwd} remaps through a path that resolves outside gitWorktreeDir ${setup.worktreeRoot}; remove the escaping symlink or omit cwd.`);
  }
  return mappedCwd;
}


export function resolveContainedRelativePath(
  root: string,
  baseDir: string,
  relativePath: string,
  description: string,
): string {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes("..")) {
    throw new Error(`atomic-workflows: relative output ${relativePath} escapes ${description} ${root}; use a path without parent traversal.`);
  }
  const candidate = resolve(baseDir, relativePath);
  if (relativePathWithin(resolve(root), candidate) === undefined) {
    throw new Error(`atomic-workflows: relative output ${relativePath} escapes ${description} ${root}.`);
  }
  const realRoot = existingRealPath(root, description);
  const realCandidate = existingRealPathThroughAncestor(candidate, "relative output");
  if (relativePathWithin(realRoot, realCandidate) === undefined) {
    throw new Error(`atomic-workflows: relative output ${relativePath} resolves outside ${description} ${root} through a symlink.`);
  }
  return candidate;
}

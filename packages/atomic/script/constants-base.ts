/**
 * Lightweight shared constants for build/release scripts.
 *
 * This module is intentionally free of heavy dependencies so that
 * scripts like bump-version can run before `bun install` in CI.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Static `package.json` files (root + published workspaces) whose
 * `version` is always bumped together. Example packages live under
 * `examples/` and are discovered dynamically by {@link getVersionFiles}
 * so adding a new example doesn't require editing this list.
 */
const STATIC_VERSION_FILES = [
  "package.json",
  "packages/atomic/package.json",
  "packages/atomic-sdk/package.json",
] as const;

/**
 * Discovers `examples/<name>/package.json` files relative to `root`.
 * Sorted alphabetically so the bump log is deterministic and tests
 * have a stable iteration order.
 */
function discoverExampleVersionFiles(root: string): string[] {
  const examplesDir = join(root, "examples");
  if (!existsSync(examplesDir)) return [];
  const entries: string[] = [];
  for (const name of readdirSync(examplesDir).sort()) {
    const pkg = join(examplesDir, name, "package.json");
    if (existsSync(pkg) && statSync(pkg).isFile()) {
      entries.push(`examples/${name}/package.json`);
    }
  }
  return entries;
}

/**
 * Full set of `package.json` files whose `version` field is bumped
 * together for a release. Combines the static published-workspace
 * files with every example package discovered under `examples/` at
 * `root`. Pass the workspace root (or a test fixture) so discovery
 * can be redirected away from the real repo.
 */
export function getVersionFiles(root: string): readonly string[] {
  return [...STATIC_VERSION_FILES, ...discoverExampleVersionFiles(root)];
}

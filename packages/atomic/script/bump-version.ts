#!/usr/bin/env bun
/**
 * Bumps the package version across all files that need it.
 *
 * Usage:
 *   bun run src/scripts/bump-version.ts <version>
 *   bun run src/scripts/bump-version.ts --from-branch
 *
 * Examples:
 *   bun run src/scripts/bump-version.ts 0.4.46
 *   bun run src/scripts/bump-version.ts 0.4.46-0
 *   bun run src/scripts/bump-version.ts --from-branch   # extracts version from current branch name
 *
 * The --from-branch flag reads the current git branch and extracts the version
 * from branch names matching:
 *   release/v0.4.46     → 0.4.46
 *   prerelease/v0.4.46-0 → 0.4.46-0
 */

import { $ } from "bun";
import { resolve } from "node:path";
import { getVersionFiles } from "./constants-base.ts";
import { findRepoRoot } from "../src/lib/workspace-paths.ts";

/**
 * Parse argv once into the values both `resolveRoot` and `getVersion` need.
 * `--root <dir>` is a leading flag pair; everything else is positional.
 */
function parseArgv(): { rootOverride: string | undefined; positional: string[] } {
  const argv = process.argv.slice(2);
  let rootOverride: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) {
      rootOverride = argv[i + 1];
      i++;
    } else {
      positional.push(argv[i] as string);
    }
  }

  return { rootOverride, positional };
}

const { rootOverride, positional } = parseArgv();

/**
 * Workspace root. `--root <dir>` overrides the default anchor-walk so tests
 * (and CI) can point the script at a temp-dir copy of the package.json files.
 */
const ROOT = rootOverride ? resolve(rootOverride) : findRepoRoot(import.meta.dir);

function parseVersionFromBranch(branch: string): string {
  const match = branch.match(/^(?:release|prerelease)\/v(.+)$/);
  if (!match) {
    console.error(
      `Error: branch "${branch}" does not match release/v<version> or prerelease/v<version>`
    );
    process.exit(1);
  }
  return match[1] as string;
}

function validateVersion(version: string): void {
  // Accept semver with optional prerelease suffix: 0.4.46, 0.4.46-0, 1.0.0-1
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    console.error(
      `Error: "${version}" is not a valid semver version`
    );
    process.exit(1);
  }
}

async function getVersion(): Promise<string> {
  const arg = positional[0];

  if (!arg) {
    console.error(
      "Usage: bun run src/scripts/bump-version.ts <version|--from-branch>"
    );
    process.exit(1);
  }

  if (arg === "--from-branch") {
    const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
    return parseVersionFromBranch(branch);
  }

  // Strip leading 'v' if provided
  return arg.replace(/^v/, "");
}

async function bumpFile(filePath: string, version: string): Promise<void> {
  const fullPath = resolve(ROOT, filePath);
  const content = await Bun.file(fullPath).json();
  const oldVersion = content.version;

  if (oldVersion === version) {
    console.log(`  ${filePath}: already at ${version}`);
    return;
  }

  content.version = version;
  await Bun.write(fullPath, JSON.stringify(content, null, 2) + "\n");
  console.log(`  ${filePath}: ${oldVersion} → ${version}`);
}

async function main(): Promise<void> {
  const version = await getVersion();
  validateVersion(version);

  console.log(`Bumping version to ${version}\n`);

  for (const file of getVersionFiles(ROOT)) {
    await bumpFile(file, version);
  }

  console.log("\nDone.");
}

main();

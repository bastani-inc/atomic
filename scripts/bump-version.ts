#!/usr/bin/env bun
/**
 * Bumps the package version across all files that need it.
 *
 * Usage:
 *   bun run scripts/bump-version.ts <version>
 *   bun run scripts/bump-version.ts --from-branch
 *
 * Examples:
 *   bun run scripts/bump-version.ts 0.4.46
 *   bun run scripts/bump-version.ts 0.4.46-0
 *   bun run scripts/bump-version.ts --from-branch   # extracts version from current branch name
 *
 * The --from-branch flag reads the current git branch and extracts the version
 * from branch names matching:
 *   release/v0.4.46      → 0.4.46
 *   prerelease/v0.4.46-0 → 0.4.46-0
 */

import { $ } from "bun";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

interface PackageJson {
  version?: string;
  [key: string]: string | number | boolean | null | PackageJsonValue[] | PackageJsonObject | undefined;
}

type PackageJsonValue = string | number | boolean | null | PackageJsonValue[] | PackageJsonObject;
type PackageJsonObject = { [key: string]: PackageJsonValue | undefined };

type VersionTarget =
  | { kind: "json"; filePath: "package.json" }
  | { kind: "readme"; filePath: "README.md" };

const VERSION_TARGETS: readonly VersionTarget[] = [
  { kind: "json", filePath: "package.json" },
  { kind: "readme", filePath: "README.md" },
];

/**
 * Parse argv once into the values both `resolveRoot` and `getVersion` need.
 * `--root <dir>` is a flag pair; everything else is positional.
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

function findRepoRoot(startDir: string): string {
  let current = resolve(startDir);

  while (true) {
    const packageJsonPath = resolve(current, "package.json");
    if (existsSync(packageJsonPath)) return current;

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Could not find repository root from ${startDir}`);
    }

    current = parent;
  }
}

const { rootOverride, positional } = parseArgv();

/**
 * Workspace root. `--root <dir>` overrides the default anchor-walk so tests
 * (and CI) can point the script at a temp-dir copy of the package files.
 */
const ROOT = rootOverride ? resolve(rootOverride) : findRepoRoot(import.meta.dir);

function parseVersionFromBranch(branch: string): string {
  const match = branch.match(/^(?:release|prerelease)\/v(.+)$/);
  if (!match) {
    console.error(
      `Error: branch "${branch}" does not match release/v<version> or prerelease/v<version>`,
    );
    process.exit(1);
  }
  return match[1] as string;
}

function validateVersion(version: string): void {
  // Accept semver with optional prerelease suffix: 0.4.46, 0.4.46-0, 1.0.0-rc.1
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    console.error(`Error: "${version}" is not a valid semver version`);
    process.exit(1);
  }
}

async function getVersion(): Promise<string> {
  const arg = positional[0];

  if (!arg) {
    console.error("Usage: bun run scripts/bump-version.ts <version|--from-branch>");
    process.exit(1);
  }

  if (arg === "--from-branch") {
    const branch = (await $`git -C ${ROOT} rev-parse --abbrev-ref HEAD`.text()).trim();
    return parseVersionFromBranch(branch);
  }

  // Strip leading 'v' if provided.
  return arg.replace(/^v/, "");
}

function shieldBadgeVersion(version: string): string {
  // Shields static badge path segments escape '-' as '--', '_' as '__', and spaces as '_'.
  return version.replaceAll("_", "__").replaceAll("-", "--").replaceAll(" ", "_");
}

async function bumpJsonFile(filePath: string, version: string): Promise<void> {
  const fullPath = resolve(ROOT, filePath);
  const content = (await Bun.file(fullPath).json()) as PackageJson;
  const oldVersion = content.version;

  if (oldVersion === version) {
    console.log(`  ${filePath}: already at ${version}`);
    return;
  }

  content.version = version;
  await Bun.write(fullPath, `${JSON.stringify(content, null, 2)}\n`);
  console.log(`  ${filePath}: ${oldVersion ?? "(none)"} → ${version}`);
}

async function bumpReadme(filePath: string, version: string): Promise<void> {
  const fullPath = resolve(ROOT, filePath);
  const content = await Bun.file(fullPath).text();
  const badgeVersion = shieldBadgeVersion(version);

  let updated = content.replace(
    /https:\/\/img\.shields\.io\/badge\/version-[^"]+-blue/g,
    `https://img.shields.io/badge/version-${badgeVersion}-blue`,
  );
  updated = updated.replace(/alt="Version [^"]+"/g, `alt="Version ${version}"`);

  if (updated === content) {
    throw new Error(`${filePath}: no version badge or alt text was updated`);
  }

  await Bun.write(fullPath, updated);
  console.log(`  ${filePath}: badge → ${version}`);
}

async function bumpTarget(target: VersionTarget, version: string): Promise<void> {
  switch (target.kind) {
    case "json":
      await bumpJsonFile(target.filePath, version);
      break;
    case "readme":
      await bumpReadme(target.filePath, version);
      break;
  }
}

async function main(): Promise<void> {
  const version = await getVersion();
  validateVersion(version);

  console.log(`Bumping version to ${version}\n`);

  for (const target of VERSION_TARGETS) {
    await bumpTarget(target, version);
  }

  console.log("\nDone.");
}

await main();

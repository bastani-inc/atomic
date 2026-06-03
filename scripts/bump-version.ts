#!/usr/bin/env bun
/**
 * Bumps every versioned workspace package manifest to the same release version.
 *
 * Usage:
 *   bun run scripts/bump-version.ts <version>
 *   bun run scripts/bump-version.ts --from-branch
 *
 * Examples:
 *   bun run scripts/bump-version.ts 0.8.0
 *   bun run scripts/bump-version.ts 0.8.0-alpha.1
 *   bun run scripts/bump-version.ts --from-branch   # extracts version from current branch name
 *
 * Accepted versions are strict release versions only:
 *   0.8.0         for stable releases
 *   0.8.0-alpha.1 for prereleases
 *
 * The --from-branch flag reads the current git branch and extracts the version
 * from branch names matching:
 *   release/0.8.0            → 0.8.0
 *   prerelease/0.8.0-alpha.1 → 0.8.0-alpha.1
 */

import { $ } from "bun";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

interface PackageJson {
  version?: string;
  [key: string]: string | number | boolean | null | PackageJsonValue[] | PackageJsonObject | undefined;
}

type PackageJsonValue = string | number | boolean | null | PackageJsonValue[] | PackageJsonObject;
type PackageJsonObject = { [key: string]: PackageJsonValue | undefined };

type VersionTarget =
  | { kind: "json"; filePath: string }
  | { kind: "readme"; filePath: string; optional?: boolean };

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

const STRICT_RELEASE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.([1-9]\d*))?$/;
const STABLE_RELEASE_BRANCH_RE = /^(?:release)\/((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const ALPHA_PRERELEASE_BRANCH_RE = /^(?:prerelease)\/((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-alpha\.[1-9]\d*)$/;

const { rootOverride, positional } = parseArgv();

/**
 * Workspace root. `--root <dir>` overrides the default anchor-walk so tests
 * (and CI) can point the script at a temp-dir copy of the package files.
 */
const ROOT = rootOverride ? resolve(rootOverride) : findRepoRoot(import.meta.dir);

function parseVersionFromBranch(branch: string): string {
  const stableMatch = branch.match(STABLE_RELEASE_BRANCH_RE);
  if (stableMatch) return stableMatch[1] as string;

  const prereleaseMatch = branch.match(ALPHA_PRERELEASE_BRANCH_RE);
  if (prereleaseMatch) return prereleaseMatch[1] as string;

  console.error(
    `Error: branch "${branch}" does not match release/MAJOR.MINOR.PATCH or prerelease/MAJOR.MINOR.PATCH-alpha.REVISION`,
  );
  process.exit(1);
}

function validateVersion(version: string): void {
  if (!STRICT_RELEASE_VERSION_RE.test(version)) {
    console.error(
      `Error: "${version}" is not a valid release version. Expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-alpha.REVISION (for example, 0.8.0 or 0.8.0-alpha.1).`,
    );
    process.exit(1);
  }
}

async function getVersion(): Promise<string> {
  const arg = positional[0];

  if (!arg || positional.length !== 1) {
    console.error("Usage: bun run scripts/bump-version.ts <version|--from-branch>");
    process.exit(1);
  }

  if (arg === "--from-branch") {
    const branch = (await $`git -C ${ROOT} rev-parse --abbrev-ref HEAD`.text()).trim();
    return parseVersionFromBranch(branch);
  }

  return arg;
}

async function hasVersionField(filePath: string): Promise<boolean> {
  const fullPath = resolve(ROOT, filePath);
  const content = (await Bun.file(fullPath).json()) as PackageJson;
  return typeof content.version === "string";
}

async function packageJsonTargets(): Promise<VersionTarget[]> {
  const packagesDir = resolve(ROOT, "packages");
  const targets: VersionTarget[] = [];

  if (existsSync(resolve(ROOT, "package.json")) && (await hasVersionField("package.json"))) {
    targets.push({ kind: "json", filePath: "package.json" });
  }

  targets.push(
    ...readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}/package.json`)
      .filter((filePath) => existsSync(resolve(ROOT, filePath)))
      .sort()
      .map((filePath) => ({ kind: "json" as const, filePath })),
  );

  return targets;
}

function readmeTargets(): VersionTarget[] {
  const packagesDir = resolve(ROOT, "packages");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/README.md`)
    .filter((filePath) => existsSync(resolve(ROOT, filePath)))
    .sort()
    .map((filePath) => ({ kind: "readme", filePath, optional: true }));
}

async function versionTargets(): Promise<VersionTarget[]> {
  return [...(await packageJsonTargets()), ...readmeTargets()];
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

async function bumpReadme(filePath: string, version: string, optional = false): Promise<void> {
  const fullPath = resolve(ROOT, filePath);
  const content = await Bun.file(fullPath).text();
  const badgeVersion = shieldBadgeVersion(version);

  let updated = content.replace(
    /https:\/\/img\.shields\.io\/badge\/version-[^"]+-blue/g,
    `https://img.shields.io/badge/version-${badgeVersion}-blue`,
  );
  updated = updated.replace(/alt="Version [^"]+"/g, `alt="Version ${version}"`);

  if (updated === content) {
    if (/https:\/\/img\.shields\.io\/badge\/version-[^"]+-blue/.test(content) || /alt="Version [^"]+"/.test(content)) {
      console.log(`  ${filePath}: badge already at ${version}`);
      return;
    }
    if (optional) {
      console.log(`  ${filePath}: no version badge`);
      return;
    }
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
      await bumpReadme(target.filePath, version, target.optional);
      break;
  }
}

async function main(): Promise<void> {
  const version = await getVersion();
  validateVersion(version);

  console.log(`Bumping workspace package versions to ${version}\n`);

  for (const target of await versionTargets()) {
    await bumpTarget(target, version);
  }

  console.log("\nDone. Run bun install to refresh bun.lock.");
}

await main();

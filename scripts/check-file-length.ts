#!/usr/bin/env bun

import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import { createGitignoreMatcher } from "./check-file-length-gitignore.js";

const DEFAULT_MAX_LINES = 500;
const GIT_COMMAND_TIMEOUT_MS = 30_000;
const GENERATED_MARKER_LINE_LIMIT = 5;

const TARGET_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".rs",
] as const;

const PATH_EXCLUSION_GLOBS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/target/**",
  "**/binaries/**",
  "**/.git/**",
  "**/vendor/**",
  "**/*.min.js",
  "**/*.min.mjs",
  "packages/workflows/skills/impeccable/**",
] as const;

const GENERATED_MARKER_PATTERN =
  /(?:@generated|auto[-\s]?generated|generated\s*--\s*do\s+not\s+edit|do\s+not\s+edit)/i;

const textDecoder = new TextDecoder();
const exclusionMatchers = PATH_EXCLUSION_GLOBS.map((pattern) => ({
  pattern,
  glob: new Bun.Glob(pattern),
}));

// Git hooks export repository-local variables; internal Git probes must honor cwd.
// This list mirrors `git rev-parse --local-env-vars` plus indexed config pairs.
const GIT_LOCAL_ENVIRONMENT_KEYS = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]);
const GIT_CONFIG_PAIR_ENVIRONMENT_PATTERN = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

interface CliOptions {
  maxLines: number;
  quiet: boolean;
  help: boolean;
}

interface FileListing {
  root: string;
  files: string[];
  source: "git" | "walk";
}

interface Violation {
  path: string;
  lines: number;
}

interface ReadFailure {
  path: string;
  message: string;
}

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

function usage(): string {
  return `Usage: bun scripts/check-file-length.ts [--max=<lines>] [--quiet] [--ci]

Checks tracked TS/JS/Rust source-like files for the Atomic 500-line limit.

Options:
  --max=<lines>   Maximum allowed physical lines per file (default: ${DEFAULT_MAX_LINES})
  --max <lines>   Same as --max=<lines>
  -q, --quiet     Suppress the clean success summary; violations are still reported
  --ci            CI-friendly quiet mode; also enabled by CI=true or GITHUB_ACTIONS=true
  -h, --help      Show this help message

In-scope extensions: ${TARGET_EXTENSIONS.join(", ")}
Path exclusions: ${PATH_EXCLUSION_GLOBS.join(", ")}
Generated-marker exclusions: first ${GENERATED_MARKER_LINE_LIMIT} lines matching ${GENERATED_MARKER_PATTERN}`;
}

function parseArgs(args: string[]): CliOptions {
  let maxLines = DEFAULT_MAX_LINES;
  let quiet = false;
  let ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--quiet" || arg === "-q") {
      quiet = true;
      continue;
    }

    if (arg === "--ci") {
      ci = true;
      quiet = true;
      continue;
    }

    if (arg.startsWith("--max=")) {
      maxLines = parseMaxLines(arg.slice("--max=".length), "--max");
      continue;
    }

    if (arg === "--max") {
      const value = args[index + 1];
      if (!value) throw new CliError("Missing value for --max");
      maxLines = parseMaxLines(value, "--max");
      index += 1;
      continue;
    }

    throw new CliError(`Unknown argument: ${arg}`);
  }

  return {
    maxLines,
    quiet: quiet || ci,
    help,
  };
}

function parseMaxLines(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError(`${flag} must be a positive integer; received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function hasTargetExtension(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return TARGET_EXTENSIONS.some((extension) => lowerPath.endsWith(extension));
}

function getPathExclusion(path: string): string | null {
  for (const matcher of exclusionMatchers) {
    if (matcher.glob.match(path)) return matcher.pattern;
  }
  return null;
}

function isGitLocalEnvironmentKey(key: string): boolean {
  return (
    GIT_LOCAL_ENVIRONMENT_KEYS.has(key) ||
    GIT_CONFIG_PAIR_ENVIRONMENT_PATTERN.test(key)
  );
}

function createGitCommandEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || isGitLocalEnvironmentKey(key)) continue;
    environment[key] = value;
  }

  return environment;
}

function runGit(args: string[], cwd: string) {
  return Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    env: createGitCommandEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
    timeout: GIT_COMMAND_TIMEOUT_MS,
  });
}

function tryListTrackedFiles(cwd: string): FileListing | null {
  const rootResult = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!rootResult.success) return null;

  const root = rootResult.stdout.toString().trim();
  if (!root) return null;

  const filesResult = runGit(["ls-files", "-z", "--full-name"], root);
  const deletedResult = runGit(["ls-files", "-z", "--deleted", "--full-name"], root);
  if (!filesResult.success || !deletedResult.success) return null;

  const deleted = new Set(
    deletedResult.stdout
      .toString()
      .split("\0")
      .filter((path) => path.length > 0)
      .map(normalizePath),
  );
  const files = filesResult.stdout
    .toString()
    .split("\0")
    .filter((path) => path.length > 0)
    .map(normalizePath)
    .filter((path) => !deleted.has(path));

  return { root, files, source: "git" };
}

function listFilesByWalking(root: string): string[] {
  const files: string[] = [];
  const pendingDirectories = [""];
  const gitignore = createGitignoreMatcher(root);

  while (pendingDirectories.length > 0) {
    const relativeDirectory = pendingDirectories.pop();
    if (relativeDirectory === undefined) continue;

    const absoluteDirectory = join(root, relativeDirectory);
    let entries: Dirent[];
    try {
      entries = readdirSync(absoluteDirectory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${normalizePath(relativeDirectory)}/${entry.name}`
        : entry.name;
      const normalizedPath = normalizePath(relativePath);

      if (entry.isDirectory()) {
        const excludedByPath = getPathExclusion(`${normalizedPath}/placeholder`) !== null;
        if (!excludedByPath && !gitignore.ignores(normalizedPath, true)) {
          pendingDirectories.push(normalizedPath);
        }
        continue;
      }

      if (entry.isFile() && !gitignore.ignores(normalizedPath, false)) {
        files.push(normalizedPath);
      }
    }
  }

  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function listCandidateFiles(cwd: string): FileListing {
  const gitListing = tryListTrackedFiles(cwd);
  if (gitListing) return gitListing;

  return {
    root: cwd,
    files: listFilesByWalking(cwd),
    source: "walk",
  };
}

function firstLinesText(bytes: Uint8Array, maxLines: number): string {
  let lineCount = 0;
  let end = bytes.length;

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 10) {
      lineCount += 1;
      if (lineCount >= maxLines) {
        end = index + 1;
        break;
      }
    }
  }

  return textDecoder.decode(bytes.subarray(0, end));
}

function hasGeneratedMarker(bytes: Uint8Array): boolean {
  return GENERATED_MARKER_PATTERN.test(
    firstLinesText(bytes, GENERATED_MARKER_LINE_LIMIT),
  );
}

function countPhysicalLines(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;

  let newlineCount = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 10) newlineCount += 1;
  }

  return bytes[bytes.length - 1] === 10 ? newlineCount : newlineCount + 1;
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function sortViolations(violations: Violation[]): Violation[] {
  return violations.sort((left, right) => {
    const lineDifference = right.lines - left.lines;
    if (lineDifference !== 0) return lineDifference;
    return left.path.localeCompare(right.path);
  });
}

function printViolations(violations: Violation[], maxLines: number): void {
  const sortedViolations = sortViolations(violations);
  const width = Math.max(...sortedViolations.map((violation) => String(violation.lines).length));

  console.error(
    `File length check failed: ${formatCount(sortedViolations.length, "file", "files")} exceed ${maxLines} physical lines.`,
  );
  console.error("");
  console.error(`${"Lines".padStart(width)}  Path`);
  console.error(`${"-".repeat(Math.max(width, "Lines".length))}  ${"-".repeat(4)}`);

  for (const violation of sortedViolations) {
    console.error(`${String(violation.lines).padStart(width)}  ${violation.path}`);
  }

  console.error("");
  console.error(
    "Split oversized authored files; only documented generated/vendored glob and marker exclusions are allowed.",
  );
}

function printReadFailures(failures: ReadFailure[]): void {
  if (failures.length === 0) return;

  console.error(
    `Unable to read ${formatCount(failures.length, "candidate file", "candidate files")}:`,
  );
  for (const failure of failures) {
    console.error(`  ${failure.path}: ${failure.message}`);
  }
}

function errorMessage(error: Error): string {
  return error.message || error.name;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const listing = listCandidateFiles(process.cwd());
  const violations: Violation[] = [];
  const readFailures: ReadFailure[] = [];
  let checkedFiles = 0;
  let skippedByPath = 0;
  let skippedByMarker = 0;

  for (const path of listing.files) {
    const normalizedPath = normalizePath(path);
    if (!hasTargetExtension(normalizedPath)) continue;

    if (getPathExclusion(normalizedPath) !== null) {
      skippedByPath += 1;
      continue;
    }

    const absolutePath = join(listing.root, normalizedPath);
    let bytes: Uint8Array;
    try {
      bytes = await Bun.file(absolutePath).bytes();
    } catch (error) {
      readFailures.push({
        path: normalizedPath,
        message: error instanceof Error ? errorMessage(error) : String(error),
      });
      continue;
    }

    if (hasGeneratedMarker(bytes)) {
      skippedByMarker += 1;
      continue;
    }

    checkedFiles += 1;
    const lineCount = countPhysicalLines(bytes);
    if (lineCount > options.maxLines) {
      violations.push({ path: normalizedPath, lines: lineCount });
    }
  }

  printReadFailures(readFailures);

  if (violations.length > 0) {
    if (readFailures.length > 0) console.error("");
    printViolations(violations, options.maxLines);
    process.exitCode = 1;
    return;
  }

  if (readFailures.length > 0) {
    process.exitCode = 1;
    return;
  }

  if (!options.quiet) {
    const rootDisplay = listing.source === "git" ? "tracked" : "walked";
    console.log(
      `File length check passed: ${formatCount(checkedFiles, "file", "files")} checked from ${rootDisplay} files (max ${options.maxLines}; skipped ${skippedByPath} by path, ${skippedByMarker} by generated marker).`,
    );
  }
}

main().catch((error) => {
  const message = error instanceof Error ? errorMessage(error) : String(error);
  console.error(`check-file-length: ${message}`);
  process.exit(2);
});

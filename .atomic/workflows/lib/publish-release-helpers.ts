import { existsSync, readdirSync } from "node:fs";
import {
  commandSummary,
  runCommand,
  type JsonValue,
  type PublishReleaseOutput,
  type ReleaseStatus,
  type ValidatedRelease,
} from "./publish-release.js";

export function excerpt(text: string, limit = 1_200): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

export function blockedOutput(
  release: ValidatedRelease,
  stage: string,
  expectedResult: string,
  text: string,
  status: ReleaseStatus = "blocked",
): PublishReleaseOutput {
  return {
    status,
    target_version: release.version,
    release_kind: release.kind,
    branch: release.branch,
    summary: [
      `publish-release stopped during ${stage} for ${release.kind} ${release.version}.`,
      `Expected result: ${expectedResult}`,
      "",
      "Stage output:",
      excerpt(text, 2_000),
    ].join("\n"),
  };
}

type GateVerification =
  | {
      readonly ok: true;
      readonly summary: string;
    }
  | {
      readonly ok: false;
      readonly summary: string;
    };

type PreparationVerification =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly releaseCommitOid: string;
    }
  | {
      readonly ok: false;
      readonly summary: string;
    };

type PackageManifest = {
  readonly name?: JsonValue;
  readonly version?: JsonValue;
  readonly private?: JsonValue;
};

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPackageManifest(path: string): Promise<PackageManifest> {
  const value = await Bun.file(path).json() as JsonValue;
  if (!isJsonObject(value)) {
    throw new Error(`${path} did not contain a JSON object`);
  }
  return value;
}

function packageManifestPaths(): readonly string[] {
  const paths = existsSync("package.json") ? ["package.json"] : [];
  if (!existsSync("packages")) return paths;

  paths.push(
    ...readdirSync("packages", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}/package.json`)
      .filter((path) => existsSync(path))
      .sort(),
  );

  return paths;
}

function releaseChangedFileAllowed(path: string): boolean {
  return path === "package.json"
    || path === "bun.lock"
    || path === "Cargo.toml"
    || path === "Cargo.lock"
    || path === "packages/natives/native/index.js"
    || /^packages\/[^/]+\/(?:package\.json|README\.md|CHANGELOG\.md)$/u.test(path);
}

export async function verifyReleasePreparation(
  release: ValidatedRelease,
  sourceHeadOid: string,
): Promise<PreparationVerification> {
  const branch = runCommand(["git", "branch", "--show-current"]);
  const head = runCommand(["git", "rev-parse", "HEAD"]);
  const status = runCommand(["git", "status", "--short"]);
  const changedFiles = runCommand(["git", "diff", "--name-only", `${sourceHeadOid}..HEAD`]);
  const failures: string[] = [];

  if (branch.exitCode !== 0 || branch.stdout !== release.branch) {
    failures.push(`current branch was ${branch.stdout || "missing"}, expected ${release.branch}`);
  }
  if (head.exitCode !== 0 || head.stdout.length === 0) failures.push("release commit HEAD could not be resolved");
  if (status.exitCode !== 0 || status.stdout.length > 0) {
    failures.push("worktree is not clean after release preparation");
  }

  const files = changedFiles.stdout.length === 0 ? [] : changedFiles.stdout.split(/\r?\n/u);
  const disallowed = files.filter((file) => !releaseChangedFileAllowed(file));
  if (changedFiles.exitCode !== 0) {
    failures.push("changed files could not be compared against the recorded source HEAD");
  }
  if (disallowed.length > 0) {
    failures.push(`release branch changed files outside the release allowlist: ${disallowed.join(", ")}`);
  }

  for (const manifestPath of packageManifestPaths()) {
    let manifest: PackageManifest;
    try {
      manifest = await readPackageManifest(manifestPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
      continue;
    }

    if (typeof manifest.version === "string" && manifest.version !== release.version) {
      failures.push(`${manifestPath} version was ${manifest.version}, expected ${release.version}`);
    }

    if (manifestPath === "packages/coding-agent/package.json" && manifest.name !== "@bastani/atomic") {
      failures.push(`${manifestPath} name was ${String(manifest.name)}, expected @bastani/atomic`);
    }

    if (manifestPath === "packages/natives/package.json") {
      if (manifest.name !== "@bastani/atomic-natives") {
        failures.push(`${manifestPath} name was ${String(manifest.name)}, expected @bastani/atomic-natives`);
      }
      if (manifest.private === true) {
        failures.push(`${manifestPath} must remain publishable because @bastani/atomic depends on it at runtime`);
      }
    } else if (manifestPath !== "packages/coding-agent/package.json"
      && manifestPath.startsWith("packages/")
      && manifest.private !== true) {
      failures.push(`${manifestPath} must remain private because it is bundled into @bastani/atomic`);
    }
  }

  const summary = [
    failures.length === 0 ? "Release preparation is deterministically verified." : "Release preparation is not verified.",
    `sourceHeadOid: ${sourceHeadOid}`,
    head.stdout.length === 0 ? undefined : `releaseCommitOid: ${head.stdout}`,
    files.length === 0 ? "changedFiles: none" : `changedFiles:\n${files.map((file) => `- ${file}`).join("\n")}`,
    failures.length === 0 ? undefined : failures.map((failure) => `- ${failure}`).join("\n"),
    commandSummary(branch),
    commandSummary(head),
    commandSummary(status),
    commandSummary(changedFiles),
  ].filter((line): line is string => line !== undefined).join("\n\n");

  if (failures.length > 0 || head.stdout.length === 0) return { ok: false, summary };
  return { ok: true, summary, releaseCommitOid: head.stdout };
}

export function runLocalReleaseChecks(release: ValidatedRelease): GateVerification {
  const branch = runCommand(["git", "branch", "--show-current"]);
  const head = runCommand(["git", "rev-parse", "HEAD"]);
  const statusBefore = runCommand(["git", "status", "--short"]);
  const typecheck = runCommand(["bun", "run", "typecheck"]);
  const unitTests = typecheck.exitCode === 0 ? runCommand(["bun", "run", "test:unit"]) : undefined;
  const statusAfter = runCommand(["git", "status", "--short"]);
  const failures: string[] = [];

  if (branch.exitCode !== 0 || branch.stdout !== release.branch) {
    failures.push(`current branch was ${branch.stdout || "missing"}, expected ${release.branch}`);
  }
  if (head.exitCode !== 0 || head.stdout.length === 0) failures.push("release commit HEAD could not be resolved");
  if (statusBefore.exitCode !== 0 || statusBefore.stdout.length > 0) failures.push("worktree was not clean before local checks");
  if (typecheck.exitCode !== 0) failures.push("bun run typecheck failed");
  if (unitTests === undefined) failures.push("bun run test:unit was skipped because typecheck failed");
  if (unitTests !== undefined && unitTests.exitCode !== 0) failures.push("bun run test:unit failed");
  if (statusAfter.exitCode !== 0 || statusAfter.stdout.length > 0) failures.push("worktree was not clean after local checks");

  return {
    ok: failures.length === 0,
    summary: [
      failures.length === 0 ? "Local release checks passed deterministically." : "Local release checks failed.",
      failures.length === 0 ? undefined : failures.map((failure) => `- ${failure}`).join("\n"),
      commandSummary(branch),
      commandSummary(head),
      commandSummary(statusBefore),
      commandSummary(typecheck),
      unitTests === undefined ? undefined : commandSummary(unitTests),
      commandSummary(statusAfter),
    ].filter((line): line is string => line !== undefined).join("\n\n"),
  };
}

export function releaseInstructions(release: ValidatedRelease): string {
  return [
    `Release kind: ${release.kind}`,
    `Target version: ${release.version}`,
    `Release branch to create from current HEAD: ${release.branch}`,
    "Repository rules:",
    "- Use Bun commands, not npm/yarn/pnpm/npx, for local development steps.",
    "- Never include a leading v in the version or tag.",
    "- Do not modify already released changelog sections; add entries only under each package CHANGELOG.md `## [Unreleased]` section.",
    `- Use \`bun run scripts/bump-version.ts ${release.version}\` and then \`bun install\` for version bumps.`,
    "- If credentials, git state, CI, or publish checks block safe progress, report the blocker clearly and stop rather than fabricating success.",
  ].join("\n");
}


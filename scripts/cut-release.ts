#!/usr/bin/env bun
/**
 * Cut a release without ever moving the working branch.
 *
 * Atomic keeps `main` versionless: every package manifest (plus the
 * lockfile, the native binding checks, and README badges) sits at the `0.0.0`
 * placeholder. The real version is materialized **only** on a throwaway
 * `Release <version>` commit that is created off the chosen base, tagged, and
 * then abandoned. The commit is reachable solely through the tag — it is never
 * merged back into `main`. This mirrors how openai/codex tags releases.
 *
 * Mechanically:
 *   1. validate the version + a clean working tree
 *   2. resolve the current attached branch (or `--base`) to its exact remote branch SHA
 *   3. stamp the real version into the worktree via scripts/bump-version.ts
 *      (bun.lock keeps main's 0.0.0 placeholders; `bun install --frozen-lockfile`
 *      tolerates the workspace version-string mismatch, so the lockfile is left as-is)
 *   4. regenerate release artifacts that must carry the stamped version, including
 *      packages/coding-agent/npm-shrinkwrap.json
 *   5. commit `Release <version>` and tag `<version>` inside the worktree
 *   6. remove the worktree — the tag (and its commit) persist in the repo
 *
 * The tag-sourced workflow only emits an inert completion signal. Protected
 * main's publish-release.yml then verifies this tagged tree as data and exports
 * a checksummed source archive, so builds never checkout a tag-selected ref.
 *
 * Usage:
 *   bun run scripts/cut-release.ts <version> [--base <ref>] [--push] [--yes]
 *
 * Examples:
 *   bun run scripts/cut-release.ts 0.8.31
 *   bun run scripts/cut-release.ts 0.9.0-alpha.1
 *   bun run scripts/cut-release.ts 0.8.31 --base main --push
 */

import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalReleaseBaseRef } from "./release-base.js";

const STRICT_RELEASE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.([1-9]\d*))?$/;
const PLACEHOLDER_VERSIONS = new Set(["0.0.0", "0.0.0-dev"]);

const ROOT = resolve(import.meta.dir, "..");

interface Options {
  version: string;
  base: string | undefined;
  push: boolean;
  yes: boolean;
}

function parseArgs(): Options {
  const argv = process.argv.slice(2);
  let version: string | undefined;
  let base: string | undefined;
  let push = false;
  let yes = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--base") {
      const candidate = argv[++i];
      if (!candidate || candidate.startsWith("-")) fail("--base requires a canonical remote branch name.");
      base = candidate;
    } else if (arg === "--push") {
      push = true;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg.startsWith("-")) {
      fail(`Unknown flag: ${arg}`);
    } else if (version === undefined) {
      version = arg;
    } else {
      fail(`Unexpected extra argument: ${arg}`);
    }
  }

  if (!version) {
    fail("Usage: bun run scripts/cut-release.ts <version> [--base <ref>] [--push] [--yes]");
  }

  return { version: version as string, base, push, yes };
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function validateVersion(version: string): void {
  if (PLACEHOLDER_VERSIONS.has(version)) {
    fail(`"${version}" is the development placeholder and must never be released.`);
  }
  if (!STRICT_RELEASE_VERSION_RE.test(version)) {
    fail(
      `"${version}" is not a valid release version. Expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-alpha.REVISION (e.g. 0.8.31 or 0.9.0-alpha.1).`,
    );
  }
}

async function gitText(args: string[], cwd: string = ROOT): Promise<string> {
  return (await $`git -C ${cwd} ${args}`.text()).trim();
}

async function main(): Promise<void> {
  const { version, base, push, yes } = parseArgs();
  validateVersion(version);

  // Refuse to operate on a dirty tree — the worktree is created from committed
  // state, so uncommitted edits would silently be excluded from the release.
  const dirty = await gitText(["status", "--porcelain"]);
  if (dirty) {
    fail("Working tree is not clean. Commit or stash changes before cutting a release.");
  }

  // The tag is the release. Never clobber an existing one.
  const existingTag = await $`git -C ${ROOT} tag --list ${version}`.text();
  if (existingTag.trim()) {
    fail(`Tag ${version} already exists.`);
  }

  await $`git -C ${ROOT} worktree prune`.quiet();

  const branch = await gitText(["rev-parse", "--abbrev-ref", "HEAD"]);
  const baseBranch = base ?? branch;
  if (baseBranch === "HEAD") {
    fail("A canonical remote base branch is required when cutting a release from detached HEAD.");
  }
  let baseRef: string;
  try {
    baseRef = canonicalReleaseBaseRef(baseBranch);
  } catch (error) {
    return fail((error as Error).message);
  }
  const remoteBase = await $`git -C ${ROOT} ls-remote --exit-code --refs origin ${baseRef}`.nothrow().quiet();
  if (remoteBase.exitCode !== 0) {
    fail(`Base ref "${baseRef}" does not exist on origin.`);
  }
  const remoteFields = remoteBase.stdout.toString().trim().split(/\s+/u);
  const baseSha = remoteFields[0];
  if (!baseSha || !/^[0-9a-f]{40}$/u.test(baseSha) || remoteFields[1] !== baseRef || remoteFields.length !== 2) {
    fail(`Base ref "${baseRef}" did not resolve to exactly one immutable remote commit.`);
  }

  const name = (await $`git -C ${ROOT} config user.name`.nothrow().text()).trim() || "atomic-release";
  const email =
    (await $`git -C ${ROOT} config user.email`.nothrow().text()).trim() ||
    "atomic-release@users.noreply.github.com";

  console.log(`Cutting release ${version}`);
  console.log(`  base:   ${baseRef} (${baseSha.slice(0, 9)})`);
  console.log(`  branch: ${branch} (left untouched)\n`);

  if (!yes) console.log("Proceeding immediately; pass --yes to suppress this notice.\n");

  const tmpRoot = mkdtempSync(join(tmpdir(), "atomic-release-"));
  const worktreeDir = join(tmpRoot, "wt");
  let worktreeAdded = false;

  try {
    await $`git -C ${ROOT} worktree add --detach ${worktreeDir} ${baseSha}`.quiet();
    worktreeAdded = true;

    // Stamp the real version into the detached worktree only, then regenerate
    // release artifacts that encode the stamped version. The shrinkwrap generator
    // is hermetic: internal Atomic packages use deterministic registry tarball
    // URLs derived from local package metadata rather than npm registry metadata.
    await $`bun run ${join(ROOT, "scripts/bump-version.ts")} ${version} --root ${worktreeDir}`;
    await $`bun run ${join(worktreeDir, "scripts/generate-coding-agent-shrinkwrap.mjs")}`;

    // bun.lock intentionally keeps main's 0.0.0 workspace placeholders: it is not
    // shipped in the npm tarball and `bun install --frozen-lockfile` tolerates the
    // mismatch, so there is no need to relock (which also avoids a network round-trip).
    await $`git -C ${worktreeDir} add -A`;
    const commitMessage = `Release ${version}\n\nRelease-base-ref: ${baseRef}\nRelease-base-sha: ${baseSha}`;
    await $`git -C ${worktreeDir} -c user.name=${name} -c user.email=${email} commit --no-verify -m ${commitMessage}`.quiet();
    // Lightweight tag, matching the repo's publish trigger + verification convention.
    await $`git -C ${worktreeDir} -c user.name=${name} -c user.email=${email} tag ${version}`.quiet();
  } finally {
    if (worktreeAdded) {
      await $`git -C ${ROOT} worktree remove --force ${worktreeDir}`.nothrow().quiet();
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  // Sanity-check the tagged tree carries the real version (and main does not).
  const taggedVersion = JSON.parse(
    await $`git -C ${ROOT} show ${`${version}:packages/coding-agent/package.json`}`.text(),
  ).version as string;
  if (taggedVersion !== version) {
    fail(`Tagged commit version ${taggedVersion} does not match ${version} — aborting.`);
  }

  const tagSha = await gitText(["rev-list", "-n", "1", version]);
  console.log(`\nCreated tag ${version} -> ${tagSha.slice(0, 9)} (Release ${version})`);
  console.log(`${branch} stays versionless; the release commit lives only on the tag.\n`);

  if (push) {
    console.log(`Pushing tag ${version}...`);
    await $`git -C ${ROOT} push origin ${version}`;
    console.log("Tag pushed. GitHub Actions will run the inert tag signal, then the protected-main publisher.");
  } else {
    console.log("Next: push the tag to trigger the signal and protected publisher:");
    console.log(`  git push origin ${version}`);
  }
}

await main();

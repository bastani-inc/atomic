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
 *   2. `git worktree add --detach <tmp> <base>` (default base: current HEAD)
 *   3. stamp the real version into the worktree via scripts/bump-version.ts
 *      (bun.lock keeps main's 0.0.0 placeholders; `bun install --frozen-lockfile`
 *      tolerates the workspace version-string mismatch, so the lockfile is left as-is)
 *   4. commit `Release <version>` and tag `<version>` inside the worktree
 *   5. remove the worktree — the tag (and its commit) persist in the repo
 *
 * Because publish.yml checks out the *tagged commit* (which now carries the
 * real version) every existing version validation passes unchanged.
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
    const arg = argv[i];
    if (arg === "--base") {
      base = argv[++i];
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

  const baseRef = base ?? "HEAD";
  const baseSha = await gitText(["rev-parse", "--verify", `${baseRef}^{commit}`]).catch(() => {
    return fail(`Base ref "${baseRef}" could not be resolved.`);
  });
  const branch = await gitText(["rev-parse", "--abbrev-ref", "HEAD"]);

  const name = (await $`git -C ${ROOT} config user.name`.nothrow().text()).trim() || "atomic-release";
  const email =
    (await $`git -C ${ROOT} config user.email`.nothrow().text()).trim() ||
    "atomic-release@users.noreply.github.com";

  console.log(`Cutting release ${version}`);
  console.log(`  base:   ${baseRef} (${baseSha.slice(0, 9)})`);
  console.log(`  branch: ${branch} (left untouched)\n`);

  if (!yes) {
    console.log("Pass --yes to skip this notice. Proceeding in 1.5s...\n");
    await Bun.sleep(1500);
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), "atomic-release-"));
  const worktreeDir = join(tmpRoot, "wt");
  let worktreeAdded = false;

  try {
    await $`git -C ${ROOT} worktree add --detach ${worktreeDir} ${baseSha}`.quiet();
    worktreeAdded = true;

    // Stamp the real version into the detached worktree only.
    await $`bun run ${join(ROOT, "scripts/bump-version.ts")} ${version} --root ${worktreeDir}`;

    // bun.lock intentionally keeps main's 0.0.0 workspace placeholders: it is not
    // shipped in the npm tarball and `bun install --frozen-lockfile` tolerates the
    // mismatch, so there is no need to relock (which also avoids a network round-trip).
    await $`git -C ${worktreeDir} add -A`;
    await $`git -C ${worktreeDir} -c user.name=${name} -c user.email=${email} commit --no-verify -m ${`Release ${version}`}`.quiet();
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
    console.log("Done. CI publish.yml will build and publish from the tag.");
  } else {
    console.log("Next: push the tag to trigger the publish pipeline:");
    console.log(`  git push origin ${version}`);
  }
}

await main();

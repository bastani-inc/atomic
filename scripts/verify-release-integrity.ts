#!/usr/bin/env bun
/** Verify that a release commit is exactly the deterministic output of cut-release.ts. */
import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyReleaseBaseMetadata } from "./release-base.js";

interface Options {
  readonly baseRef: string;
  readonly releaseCommit: string;
  readonly expectedBaseRef?: string;
  readonly expectedBaseSha?: string;
}

function fail(message: string): never {
  throw new Error(`Release integrity check failed: ${message}`);
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  let baseRef = "origin/main";
  let releaseCommit = "HEAD";
  let expectedBaseRef: string | undefined;
  let expectedBaseSha: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base-ref" && args[i + 1]) baseRef = args[++i] as string;
    else if (args[i] === "--release-commit" && args[i + 1]) releaseCommit = args[++i] as string;
    else if (args[i] === "--expected-base-ref" && args[i + 1]) expectedBaseRef = args[++i] as string;
    else if (args[i] === "--expected-base-sha" && args[i + 1]) expectedBaseSha = args[++i] as string;
    else fail(`unknown or incomplete argument: ${args[i]}`);
  }
  if ((expectedBaseRef === undefined) !== (expectedBaseSha === undefined)) {
    fail("--expected-base-ref and --expected-base-sha must be supplied together");
  }
  return { baseRef, releaseCommit, expectedBaseRef, expectedBaseSha };
}

const ROOT = resolve(import.meta.dir, "..");

async function git(args: string[], cwd = ROOT): Promise<string> {
  const result = await $`git -C ${cwd} ${args}`.nothrow().quiet();
  if (result.exitCode !== 0) fail(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}
async function gitRaw(args: string[], cwd = ROOT): Promise<string> {
  const result = await $`git -C ${cwd} ${args}`.nothrow().quiet();
  if (result.exitCode !== 0) fail(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

async function main(): Promise<void> {
  const { baseRef, releaseCommit, expectedBaseRef, expectedBaseSha } = parseArgs();
  const releaseSha = await git(["rev-parse", "--verify", `${releaseCommit}^{commit}`]);
  const parents = (await git(["show", "-s", "--format=%P", releaseSha])).split(/\s+/).filter(Boolean);
  if (parents.length !== 1) fail(`release commit must have exactly one parent; found ${parents.length}`);
  const parent = parents[0] as string;

  if (expectedBaseRef !== undefined && expectedBaseSha !== undefined) {
    const message = await gitRaw(["show", "-s", "--format=%B", releaseSha]);
    try {
      verifyReleaseBaseMetadata(message, parent, expectedBaseRef, expectedBaseSha);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  const ancestry = await $`git -C ${ROOT} merge-base --is-ancestor ${parent} ${baseRef}`.nothrow().quiet();
  if (ancestry.exitCode !== 0) fail(`release parent ${parent} is not integrated into ${baseRef}`);

  const version = JSON.parse(await git(["show", `${releaseSha}:packages/coding-agent/package.json`])).version as string;
  const subject = await git(["show", "-s", "--format=%s", releaseSha]);
  if (subject !== `Release ${version}`) fail(`commit subject must be "Release ${version}"; found "${subject}"`);

  const tempRoot = mkdtempSync(join(tmpdir(), "atomic-release-integrity-"));
  const worktree = join(tempRoot, "expected");
  let added = false;
  try {
    await $`git -C ${ROOT} worktree add --detach ${worktree} ${parent}`.quiet();
    added = true;
    await $`bun run ${join(worktree, "scripts/bump-version.ts")} ${version} --root ${worktree}`.quiet();
    await $`bun run ${join(worktree, "scripts/generate-coding-agent-shrinkwrap.mjs")}`.quiet();
    await $`git -C ${worktree} add -A`.quiet();
    const expectedTree = (await $`git -C ${worktree} write-tree`.text()).trim();
    const releaseTree = await git(["show", "-s", "--format=%T", releaseSha]);
    if (expectedTree !== releaseTree) {
      const changed = await git(["diff", "--name-status", parent, releaseSha]);
      fail(`release tree does not match deterministic version/shrinkwrap output\n${changed}`);
    }
  } finally {
    if (added) await $`git -C ${ROOT} worktree remove --force ${worktree}`.nothrow().quiet();
    rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log(`Release integrity verified: ${releaseSha} is deterministic output from integrated parent ${parent}.`);
}

await main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});

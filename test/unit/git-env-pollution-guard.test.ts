import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { runGitChecked } from "../../packages/workflows/src/runs/shared/worktree-git.js";
import { cleanupWorktrees, createWorktrees } from "../../packages/workflows/src/runs/shared/worktree-setup.js";

/**
 * Regression guard for the 2026-07-20 core.worktree pollution incident.
 *
 * Git hooks export repository-local environment variables, and a nested
 * `git init` run with `GIT_DIR=<foreign .git>` and `GIT_WORK_TREE=<cwd>`
 * persists `core.worktree=<cwd>` into the foreign repository's config —
 * silently redirecting that checkout. This is documented git behavior, not
 * a git bug; the invariant under test is OURS: every repository git-spawning
 * helper must scrub hook-inherited repository-local env before spawning.
 */

let sentinelRepo: string;
let sentinelConfigBefore: string;
let fixtureDir: string;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
	sentinelRepo = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-git-env-sentinel-")));
	fixtureDir = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-git-env-fixture-")));
	const init = spawnSync("git", ["init", "--quiet", "--initial-branch=main"], {
		cwd: sentinelRepo,
		env: createGitEnvironment(),
	});
	assert.equal(init.status, 0, init.stderr?.toString());
	sentinelConfigBefore = readFileSync(join(sentinelRepo, ".git", "config"), "utf-8");

	// Hook-style env aimed at the sentinel; GIT_WORK_TREE matches the nested
	// command's cwd — the exact combination that persists core.worktree.
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
		savedEnv.set(key, process.env[key]);
	}
	process.env.GIT_DIR = join(sentinelRepo, ".git");
	process.env.GIT_WORK_TREE = fixtureDir;
	process.env.GIT_INDEX_FILE = join(sentinelRepo, ".git", "index");
});

afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	savedEnv.clear();
	rmSync(sentinelRepo, { recursive: true, force: true });
	rmSync(fixtureDir, { recursive: true, force: true });
});

test("full worktree lifecycle stays scrubbed and only writes shared core.hooksPath", () => {
	runGitChecked(fixtureDir, ["init", "--quiet", "--initial-branch=main"]);
	runGitChecked(fixtureDir, ["config", "--local", "user.name", "Atomic Fixture"]);
	runGitChecked(fixtureDir, ["config", "--local", "user.email", "fixture@example.com"]);
	writeFileSync(join(fixtureDir, "tracked.txt"), "fixture\n");
	mkdirSync(join(fixtureDir, ".husky"));
	writeFileSync(join(fixtureDir, ".husky", "pre-commit"), "#!/bin/sh\n");
	runGitChecked(fixtureDir, ["add", "."]);
	runGitChecked(fixtureDir, ["commit", "--no-gpg-sign", "-m", "fixture"]);

	const configPath = join(fixtureDir, ".git", "config");
	const keysBefore = runGitChecked(fixtureDir, ["config", "--file", configPath, "--name-only", "--list"])
		.trim().split("\n").filter(Boolean);
	const setup = createWorktrees(fixtureDir, "hostile/nested", 1, { symlinkDirectories: [] });
	const worktree = setup.worktrees[0]!;
	assert.equal(worktree.path, join(fixtureDir, ".atomic", "worktrees", "hostile+nested-0"));
	assert.equal(runGitChecked(worktree.path, ["branch", "--show-current"]).trim(), "worktree-hostile+nested-0");
	assert.equal(readFileSync(join(fixtureDir, ".atomic", "worktrees", ".gitignore"), "utf8"), "*\n");
	cleanupWorktrees(setup);
	cleanupWorktrees(setup);
	assert.equal(existsSync(worktree.path), false);
	assert.notEqual(runGitChecked(fixtureDir, ["branch", "--list", "worktree-hostile+nested-0"]).trim(), "worktree-hostile+nested-0");

	const keysAfter = runGitChecked(fixtureDir, ["config", "--file", configPath, "--name-only", "--list"])
		.trim().split("\n").filter(Boolean);
	assert.deepEqual(keysAfter.filter((key) => !keysBefore.includes(key)), ["core.hookspath"]);
	const invokingConfig = readFileSync(configPath, "utf8");
	assert.ok(!invokingConfig.toLowerCase().includes("worktree ="), `invoking config gained core.worktree:\n${invokingConfig}`);
	const sentinelAfter = readFileSync(join(sentinelRepo, ".git", "config"), "utf-8");
	assert.equal(sentinelAfter, sentinelConfigBefore, "sentinel repository config must be byte-identical");
});

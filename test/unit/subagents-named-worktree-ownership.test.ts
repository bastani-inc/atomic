import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { ensureNamedWorktree } from "../../packages/subagents/src/runs/shared/named-worktree.js";
import * as namedGit from "../../packages/subagents/src/runs/shared/named-worktree-git.js";
import { spawnSyncCollect } from "../helpers/runtime.js";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(repo: string, ...args: string[]): string {
	const result = spawnSyncCollect(["git", "-C", repo, ...args], { env: createGitEnvironment() });
	assert.equal(result.exitCode, 0, `${args.join(" ")}: ${result.stderr}`);
	return result.stdout.toString().trim();
}

function makeRepo(): string {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "named-worktree-ownership-")));
	roots.push(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "commit.gpgsign", "false");
	git(repo, "config", "core.autocrlf", "false");
	writeFileSync(join(repo, "README.md"), "hello\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "init");
	return repo;
}

for (const interrupted of [false, true]) {
	test(`a foreign no-checkout add is not attributed to an Atomic add that ${interrupted ? "is cancelled" : "exits normally"} (#5202)`, async () => {
		const repo = makeRepo();
		const target = join(repo, "foreign");
		const realAdd = namedGit.addNamedWorktree;
		let raced = false;
		vi.spyOn(namedGit, "addNamedWorktree").mockImplementation(async (cwd, args, env, signal) => {
			if (!raced) {
				raced = true;
				git(repo, "worktree", "add", "--no-checkout", "-b", "feat/foreign", target);
				if (interrupted) throw new Error("cancel before Git creates an entry");
			}
			return realAdd(cwd, args, env, signal);
		});
		const first = ensureNamedWorktree(repo, { branch: "feat/foreign", path: target });
		if (interrupted) await assert.rejects(first, /cancel before Git creates an entry/);
		else assert.equal((await first).path, target);
		for (let index = 0; index < 3; index++) {
			assert.equal((await ensureNamedWorktree(repo, { branch: "feat/foreign", path: target })).path, target);
		}
		assert.equal(existsSync(join(repo, ".git", "worktrees", "foreign", "index")), false);
		assert.equal(existsSync(join(repo, ".git", "worktrees", "foreign", "locked")), false);
	});
}

for (const state of ["missing HEAD", "HEAD.lock", "branch lock"]) {
	test(`an interrupted owned add with ${state} is refused with usable recovery guidance (#5202)`, async () => {
		const repo = makeRepo();
		const target = join(repo, "owned");
		git(
			repo,
			"worktree",
			"add",
			"--lock",
			"--reason",
			"atomic-named-worktree-add:interrupted",
			"-b",
			"feat/owned",
			target,
		);
		const entry = join(repo, ".git", "worktrees", "owned");
		if (state === "missing HEAD") rmSync(join(entry, "HEAD"));
		else if (state === "HEAD.lock") writeFileSync(join(entry, "HEAD.lock"), "pending\n");
		else writeFileSync(join(repo, ".git", "refs", "heads", "feat", "owned.lock"), "pending\n");
		await assert.rejects(ensureNamedWorktree(repo, { branch: "feat/owned", path: target }), (error: Error) => {
			assert.equal(error.name, "WorktreeBusyError");
			assert.match(error.message, /interrupted named-worktree/);
			assert.match(error.message, /worktree unlock/);
			assert.match(error.message, /worktree prune/);
			assert.match(error.message, /HEAD\.lock|reference.*\.lock/);
			return true;
		});
		assert.equal(readFileSync(join(target, "README.md"), "utf8"), "hello\n");
		git(repo, "worktree", "unlock", target);
		rmSync(target, { recursive: true });
		git(repo, "worktree", "prune");
		rmSync(join(repo, ".git", "refs", "heads", "feat", "owned.lock"), { force: true });
		const repaired = await ensureNamedWorktree(repo, { branch: "feat/owned", path: target });
		assert.equal(readFileSync(join(repaired.path, "README.md"), "utf8"), "hello\n");
	});
}

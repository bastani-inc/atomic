import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { ensureNamedWorktree } from "../../packages/subagents/src/runs/shared/named-worktree.js";
import { spawnSyncCollect } from "../helpers/runtime.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(repo: string, ...args: string[]): string {
	const result = spawnSyncCollect(["git", "-C", repo, ...args], { env: createGitEnvironment() });
	assert.equal(result.exitCode, 0, `${args.join(" ")}: ${result.stderr}`);
	return result.stdout.toString().trim();
}

function makeRepo(): { root: string; repo: string; initCommit: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "named-worktree-revisions-")));
	roots.push(root);
	const repo = join(root, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "commit.gpgsign", "false");
	git(repo, "config", "core.autocrlf", "false");
	writeFileSync(join(repo, "README.md"), "hello\n");
	git(repo, "add", "README.md");
	git(repo, "commit", "-qm", "init commit");
	return { root, repo, initCommit: git(repo, "rev-parse", "HEAD") };
}

test("a launch from a linked worktree without an upstream resolves the default and explicit HEAD start point in the caller worktree (#5202)", async () => {
	const { root, repo, initCommit } = makeRepo();
	const sessionWorktree = join(root, "session");
	git(repo, "worktree", "add", "-q", "-b", "feat/session", sessionWorktree);
	writeFileSync(join(sessionWorktree, "session.txt"), "from session\n");
	git(sessionWorktree, "add", "session.txt");
	git(sessionWorktree, "commit", "-qm", "session work");
	const sessionHead = git(sessionWorktree, "rev-parse", "HEAD");
	assert.notEqual(sessionHead, initCommit);

	const fromDefault = await ensureNamedWorktree(sessionWorktree, { branch: "feat/child-default" });
	assert.equal(fromDefault.baseCommit, sessionHead);
	assert.equal(git(fromDefault.path, "rev-parse", "HEAD"), sessionHead);
	assert.equal(readFileSync(join(fromDefault.path, "session.txt"), "utf8"), "from session\n");

	const fromExplicitHead = await ensureNamedWorktree(sessionWorktree, { branch: "feat/child-head", base: "HEAD" });
	assert.equal(fromExplicitHead.baseCommit, sessionHead);
	assert.equal(git(fromExplicitHead.path, "rev-parse", "HEAD"), sessionHead);
	assert.equal(readFileSync(join(fromExplicitHead.path, "session.txt"), "utf8"), "from session\n");
});

test("an explicit commit-message search base such as :/init commit resolves to the matching commit (#5202)", async () => {
	const { repo, initCommit } = makeRepo();
	writeFileSync(join(repo, "later.txt"), "later\n");
	git(repo, "add", "later.txt");
	git(repo, "commit", "-qm", "later commit");
	assert.notEqual(git(repo, "rev-parse", "HEAD"), initCommit);

	const created = await ensureNamedWorktree(repo, { branch: "feat/from-search", base: ":/init commit" });
	assert.equal(created.baseCommit, initCommit);
	assert.equal(git(created.path, "rev-parse", "HEAD"), initCommit);
	assert.equal(existsSync(join(created.path, "later.txt")), false);

	await assert.rejects(
		ensureNamedWorktree(repo, { branch: "feat/blob-base", base: "HEAD:README.md" }),
		/invalid reference: HEAD:README\.md/,
	);
});

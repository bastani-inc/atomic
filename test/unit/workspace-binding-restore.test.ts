import assert from "node:assert/strict";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	isWorkspaceBindingError,
	isWorkspaceRestoreError,
	resolveWorkspace,
	restoreWorkspace,
	WorkspaceRestoreError,
	workspace,
} from "../../packages/coding-agent/src/core/workspace/index.ts";
import {
	commitFile,
	countGitCommands,
	createRemote,
	createRepository,
	git,
	type WorkspaceSandboxDirs,
	workspaceSandbox,
} from "../helpers/workspace-repos.ts";

let dirs: WorkspaceSandboxDirs;

beforeEach(() => {
	dirs = workspaceSandbox("atomic-workspace-restore-");
});

afterEach(() => {
	dirs.cleanup();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	assert.fail("expected a rejection");
}

async function boundBranch(name: string) {
	const repo = createRepository(dirs.root, name);
	const binding = await resolveWorkspace(workspace({ repo, branch: `${name}-work`, label: "ci" }));
	return { repo, binding };
}

describe("restoreWorkspace (#3109)", () => {
	test("returns the verified path of an intact binding with new commits and dirty files (#3109)", async () => {
		const { binding } = await boundBranch("intact");
		commitFile(binding.worktree, "progress.txt", "expected work\n");
		const { result, commands } = await countGitCommands(() => restoreWorkspace(binding));
		assert.equal(result, realpathSync(binding.worktree));
		assert.equal(
			commands.filter((args) => args[0] === "worktree" && args[1] === "add").length,
			0,
			"an intact worktree is verified, not re-added",
		);
	});

	test("re-adds a deleted worktree from its branch (#3109)", async () => {
		const { binding } = await boundBranch("deleted");
		const head = commitFile(binding.worktree, "kept.txt", "committed before deletion\n");
		rmSync(binding.worktree, { recursive: true, force: true });
		assert.equal(await restoreWorkspace(binding), realpathSync(binding.worktree));
		assert.equal(git(binding.worktree, "rev-parse", "HEAD"), head);
		assert.equal(git(binding.worktree, "symbolic-ref", "--short", "HEAD"), binding.branch);
	});

	test("re-adds a remote binding from the pushed branch after the shared store is gone (#3109)", async () => {
		const remote = createRemote(dirs.root, "rebuild");
		const binding = await resolveWorkspace(workspace({ repo: remote.url, branch: "pushed" }));
		const head = commitFile(binding.worktree, "pushed.txt", "on the remote\n");
		git(binding.worktree, "push", "-q", "origin", "pushed");
		rmSync(binding.worktree, { recursive: true, force: true });
		rmSync(binding.repository, { recursive: true, force: true });
		assert.equal(await restoreWorkspace(binding), binding.worktree);
		assert.equal(git(binding.worktree, "rev-parse", "HEAD"), head);
	});

	test("fails closed when the worktree moved to another branch (#3109)", async () => {
		const { binding } = await boundBranch("switched");
		git(binding.worktree, "checkout", "-q", "-b", "unexpected");
		const error = await rejection(restoreWorkspace(binding));
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "wrong-branch");
		assert.equal(error.fields.expected, binding.branch);
		assert.equal(error.fields.actual, "unexpected");
	});

	test("fails closed when the path now holds another repository (#3109)", async () => {
		const { binding } = await boundBranch("replaced");
		git(binding.repository, "worktree", "remove", "--force", binding.worktree);
		const impostor = createRepository(dirs.root, "impostor");
		git(impostor, "worktree", "add", "-q", "-b", binding.branch, binding.worktree);
		const error = await rejection(restoreWorkspace(binding));
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "wrong-repository");
		assert.equal(error.reason, "different-repository");
	});

	test("fails closed with drift when the branch no longer contains the recorded head (#3109)", async () => {
		const { repo, binding } = await boundBranch("rewritten");
		commitFile(binding.worktree, "a.txt", "a\n");
		const recorded = { ...binding, head: git(binding.worktree, "rev-parse", "HEAD") };
		git(binding.worktree, "reset", "-q", "--hard", git(repo, "rev-parse", "HEAD"));
		commitFile(binding.worktree, "b.txt", "rewritten history\n");
		const error = await rejection(restoreWorkspace(recorded));
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "drift");
		assert.equal(error.reason, "history-rewritten");
		assert.equal(error.fields.expected, recorded.head);
		assert.equal(error.fields.actual, git(binding.worktree, "rev-parse", "HEAD"));
	});

	test("fails closed with drift when a recorded remote changed or disappeared (#3109)", async () => {
		const { repo, binding } = await boundBranch("remotes");
		const recorded = { ...binding, remotes: ["https://example.com/acme/remotes.git"] };
		const missing = await rejection(restoreWorkspace(recorded));
		assert.ok(isWorkspaceBindingError(missing));
		assert.equal(missing.code, "drift");
		assert.equal(missing.reason, "remote-changed");
		assert.deepEqual(missing.fields.actual, []);
		git(repo, "remote", "add", "origin", "https://example.com/acme/other.git");
		const changed = await rejection(restoreWorkspace(recorded));
		assert.ok(isWorkspaceBindingError(changed));
		assert.equal(changed.fields.expected, "https://example.com/acme/remotes.git");
		assert.deepEqual(changed.fields.actual, ["https://example.com/acme/other.git"]);
		git(repo, "remote", "set-url", "origin", "https://example.com/acme/remotes.git");
		assert.equal(await restoreWorkspace(recorded), binding.worktree, "a restored remote passes again");
	});

	test("reports restore-failed when the branch and the worktree are both gone (#3109)", async () => {
		const { repo, binding } = await boundBranch("gone");
		git(repo, "worktree", "remove", "--force", binding.worktree);
		git(repo, "branch", "-D", binding.branch);
		const error = await rejection(restoreWorkspace(binding));
		assert.ok(isWorkspaceRestoreError(error));
		assert.ok(error instanceof WorkspaceRestoreError);
		assert.equal(error.code, "restore-failed");
		assert.equal(error.reason, "branch-missing");
		assert.equal(error.fields.branch, binding.branch);
		assert.equal(existsSync(binding.worktree), false);
	});

	test("reports restore-failed when the local repository is gone, before any git work (#3109)", async () => {
		const { repo, binding } = await boundBranch("vanished");
		rmSync(repo, { recursive: true, force: true });
		const { result, commands } = await countGitCommands(() => rejection(restoreWorkspace(binding)));
		assert.ok(isWorkspaceRestoreError(result));
		assert.equal(result.reason, "repository-missing");
		assert.equal(result.fields.repository, binding.repository);
		assert.ok(commands.length <= 1, "at most the git availability probe ran");
	});

	test("re-adds a deleted worktree from the remote's copy of a branch the store no longer has (#3109)", async () => {
		const remote = createRemote(dirs.root, "refetch");
		const binding = await resolveWorkspace(workspace({ repo: remote.url, branch: "refetched" }));
		const head = commitFile(binding.worktree, "pushed.txt", "pushed\n");
		git(binding.worktree, "push", "-q", "origin", "refetched");
		git(binding.repository, "worktree", "remove", "--force", binding.worktree);
		git(binding.repository, "branch", "-D", "refetched");
		git(binding.repository, "update-ref", "-d", "refs/remotes/origin/refetched");
		const { result, commands } = await countGitCommands(() => restoreWorkspace(binding));
		assert.equal(result, binding.worktree);
		assert.equal(git(binding.worktree, "rev-parse", "HEAD"), head);
		assert.equal(commands.filter((args) => args[0] === "fetch").length, 1);
	});

	test("re-adds a local binding from its origin's copy of the branch (#3109)", async () => {
		const remote = createRemote(dirs.root, "local-origin");
		const clone = join(dirs.root, "local-origin-clone");
		git(dirs.root, "clone", "-q", remote.url.replace(/^file:\/\//, ""), clone);
		const binding = await resolveWorkspace(workspace({ repo: clone, branch: "topic" }));
		const head = commitFile(binding.worktree, "topic.txt", "topic\n");
		git(binding.worktree, "push", "-q", "origin", "topic");
		git(clone, "fetch", "-q", "origin");
		git(clone, "worktree", "remove", "--force", binding.worktree);
		git(clone, "branch", "-D", "topic");
		const { result, commands } = await countGitCommands(() => restoreWorkspace(binding));
		assert.equal(result, binding.worktree);
		assert.equal(git(binding.worktree, "rev-parse", "HEAD"), head);
		assert.equal(commands.filter((args) => args[0] === "fetch").length, 0, "a local repository is not fetched");
	});
});

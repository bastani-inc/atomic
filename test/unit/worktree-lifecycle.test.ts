import { test } from "bun:test";

// The setup-hook failure contract executes a bash-shebang script directly,
// which Windows cannot spawn; the error-path contract runs on unix jobs.
const unixTest = process.platform === "win32" ? test.skip : test;
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupWorktrees, createWorktrees } from "../../packages/workflows/src/runs/shared/worktree-setup.js";
import { diffWorktrees } from "../../packages/workflows/src/runs/shared/worktree-diff.js";
import { runGit, runGitChecked, runGitPlain } from "../../packages/workflows/src/runs/shared/worktree-git.js";
import {
	cleanupWorktrees as cleanupSubagentWorktrees,
	createWorktrees as createSubagentWorktrees,
} from "../../packages/subagents/src/runs/shared/worktree.js";

function createRepository(ignoreSettings = true): { root: string; repo: string } {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-worktree-lifecycle-")));
	const repo = join(root, "repo");
	mkdirSync(repo);
	runGitChecked(repo, ["init", "-b", "main"]);
	runGitChecked(repo, ["config", "user.name", "Atomic Test"]);
	runGitChecked(repo, ["config", "user.email", "atomic@example.com"]);
	writeFileSync(join(repo, ".gitignore"), [
		...(ignoreSettings ? [".atomic/settings.local.json", ".atomic/settings.json"] : []),
		"ignored/", "deps/", "",
	].join("\n"));
	writeFileSync(join(repo, ".worktreeinclude"), "ignored/**/*.txt\n");
	mkdirSync(join(repo, "packages", "api"), { recursive: true });
	writeFileSync(join(repo, "packages", "api", "tracked.txt"), "tracked\n");
	runGitChecked(repo, ["add", "."]);
	runGitChecked(repo, ["commit", "--no-gpg-sign", "-m", "initial"]);
	return { root, repo };
}

test("temporary worktree uses main-root path, flattened branch, and post-creation setup", () => {
	const { root, repo } = createRepository();
	mkdirSync(join(repo, ".atomic"), { recursive: true });
	writeFileSync(join(repo, ".atomic", "settings.local.json"), "{\"local\":true}\n");
	writeFileSync(join(repo, ".atomic", "settings.json"), "{\"shared\":true}\n");
	mkdirSync(join(repo, "ignored", "nested"), { recursive: true });
	writeFileSync(join(repo, "ignored", "nested", "secret.txt"), "included\n");
	writeFileSync(join(repo, "ignored", "skip.log"), "excluded\n");
	mkdirSync(join(repo, "deps"));
	writeFileSync(join(repo, "deps", "module.txt"), "dependency\n");
	let setup;
	try {
		setup = createWorktrees(join(repo, "packages", "api"), "feature/name", 1, {
			baseBranch: "main",
			symlinkDirectories: ["deps"],
		});
		const worktree = setup.worktrees[0]!;
		assert.equal(worktree.path, join(repo, ".atomic", "worktrees", "feature+name-0"));
		assert.equal(worktree.agentCwd, join(worktree.path, "packages", "api"));
		assert.equal(worktree.branch, "worktree-feature+name-0");
		assert.equal(runGitChecked(worktree.path, ["branch", "--show-current"]).trim(), worktree.branch);
		assert.equal(readFileSync(join(worktree.path, ".atomic", "settings.local.json"), "utf8"), "{\"local\":true}\n");
		assert.equal(readFileSync(join(worktree.path, ".atomic", "settings.json"), "utf8"), "{\"shared\":true}\n");
		assert.equal(readFileSync(join(worktree.path, "ignored", "nested", "secret.txt"), "utf8"), "included\n");
		assert.equal(existsSync(join(worktree.path, "ignored", "skip.log")), false);
		assert.equal(lstatSync(join(worktree.path, "deps")).isSymbolicLink(), true);
	} finally {
		if (setup) cleanupWorktrees(setup);
		assert.equal(runGitChecked(repo, ["branch", "--list", "worktree-feature+name-0"]).trim(), "");
		rmSync(root, { recursive: true, force: true });
	}
});


test("non-ignored local settings propagate without leaking into patches and repeated creation stays usable", () => {
	const { root, repo } = createRepository(false);
	const diffs = join(root, "diffs");
	mkdirSync(join(repo, ".atomic"), { recursive: true });
	writeFileSync(join(repo, ".atomic", "settings.local.json"), "{\"secret\":true}\n");
	writeFileSync(join(repo, ".atomic", "settings.json"), "{\"local\":true}\n");
	let first: ReturnType<typeof createWorktrees> | undefined;
	let second: ReturnType<typeof createWorktrees> | undefined;
	try {
		first = createWorktrees(repo, "settings/first", 1, { baseBranch: "main", symlinkDirectories: [] });
		assert.equal(readFileSync(join(first.worktrees[0]!.path, ".atomic", "settings.local.json"), "utf8"), "{\"secret\":true}\n");
		writeFileSync(join(first.worktrees[0]!.path, "agent-change.txt"), "agent\n");
		const [diff] = diffWorktrees(first, ["worker"], diffs);
		assert.ok(diff);
		assert.doesNotMatch(readFileSync(diff.patchPath, "utf8"), /settings\.(?:local\.)?json|secret/);
		cleanupWorktrees(first);
		first = undefined;
		assert.equal(readFileSync(join(repo, ".atomic", "worktrees", ".gitignore"), "utf8"), "*\n");
		second = createWorktrees(repo, "settings/second", 1, { baseBranch: "main", symlinkDirectories: [] });
		assert.equal(existsSync(second.worktrees[0]!.path), true);
		writeFileSync(join(repo, "packages", "api", "tracked.txt"), "modified\n");
		assert.throws(() => createWorktrees(repo, "tracked/dirty", 1), /clean git working tree/);
	} finally {
		if (first) cleanupWorktrees(first);
		if (second) cleanupWorktrees(second);
		rmSync(root, { recursive: true, force: true });
	}
});
test("linked-worktree invocation anchors temporary worktrees at the main root", () => {
	const { root, repo } = createRepository();
	const linked = join(root, "linked-source");
	let setup;
	try {
		runGitChecked(repo, ["worktree", "add", "--detach", linked]);
		setup = createWorktrees(join(linked, "packages", "api"), "inside/linked", 1, { baseBranch: "main" });
		const created = setup.worktrees[0]!;
		assert.equal(created.path, join(repo, ".atomic", "worktrees", "inside+linked-0"));
		assert.equal(created.agentCwd, join(created.path, "packages", "api"));
		assert.equal(created.branch, "worktree-inside+linked-0");
	} finally {
		if (setup) cleanupWorktrees(setup);
		assert.equal(runGitChecked(repo, ["branch", "--list", "worktree-inside+linked-0"]).trim(), "");
		rmSync(root, { recursive: true, force: true });
	}
});
test("default base ref fetches a missing origin default branch", () => {
	const { root, repo } = createRepository();
	const remote = join(root, "remote.git");
	let setup: ReturnType<typeof createWorktrees> | undefined;
	try {
		mkdirSync(remote);
		runGitChecked(remote, ["init", "--bare", "--initial-branch=main"]);
		runGitChecked(repo, ["remote", "add", "origin", remote]);
		runGitChecked(repo, ["push", "-u", "origin", "main"]);
		runGitChecked(repo, ["remote", "set-head", "origin", "main"]);
		const remoteCommit = runGitChecked(repo, ["rev-parse", "origin/main"]).trim();
		writeFileSync(join(repo, "local-only.txt"), "local\n");
		runGitChecked(repo, ["add", "local-only.txt"]);
		runGitChecked(repo, ["commit", "--no-gpg-sign", "-m", "local ahead"]);
		runGitChecked(repo, ["update-ref", "-d", "refs/remotes/origin/main"]);
		assert.notEqual(runGit(repo, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"]).status, 0);
		setup = createWorktrees(repo, "remote-default", 1);
		assert.equal(runGitChecked(setup.worktrees[0]!.path, ["rev-parse", "HEAD"]).trim(), remoteCommit);
		assert.equal(runGitChecked(repo, ["show-ref", "--verify", "refs/remotes/origin/main"]).trim().length > 0, true);
	} finally {
		if (setup) cleanupWorktrees(setup);
		rmSync(root, { recursive: true, force: true });
	}
});

test("post-creation setup writes exact hooks paths and skips an already-correct write", () => {
	const huskyRepo = createRepository();
	let first: ReturnType<typeof createWorktrees> | undefined;
	let second: ReturnType<typeof createWorktrees> | undefined;
	try {
		mkdirSync(join(huskyRepo.repo, ".husky"));
		first = createWorktrees(huskyRepo.repo, "hooks/husky", 1, { baseBranch: "main", symlinkDirectories: [] });
		assert.equal(runGitPlain(huskyRepo.repo, ["config", "--get", "core.hooksPath"]).stdout.trim(), join(huskyRepo.repo, ".husky"));
		cleanupWorktrees(first);
		first = undefined;
		const configBefore = readFileSync(join(huskyRepo.repo, ".git", "config"), "utf8");
		second = createWorktrees(huskyRepo.repo, "hooks/idempotent", 1, { baseBranch: "main", symlinkDirectories: [] });
		assert.equal(readFileSync(join(huskyRepo.repo, ".git", "config"), "utf8"), configBefore);
	} finally {
		if (first) cleanupWorktrees(first);
		if (second) cleanupWorktrees(second);
		rmSync(huskyRepo.root, { recursive: true, force: true });
	}

	const nativeRepo = createRepository();
	let nativeSetup: ReturnType<typeof createWorktrees> | undefined;
	try {
		writeFileSync(join(nativeRepo.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
		nativeSetup = createWorktrees(nativeRepo.repo, "hooks/native", 1, { baseBranch: "main", symlinkDirectories: [] });
		assert.equal(runGitPlain(nativeRepo.repo, ["config", "--get", "core.hooksPath"]).stdout.trim(), join(nativeRepo.repo, ".git", "hooks"));
	} finally {
		if (nativeSetup) cleanupWorktrees(nativeSetup);
		rmSync(nativeRepo.root, { recursive: true, force: true });
	}
});

test("temporary base ref precedence is explicit then origin default then HEAD", () => {
	const explicitRepo = createRepository();
	let explicitSetup: ReturnType<typeof createWorktrees> | undefined;
	try {
		runGitChecked(explicitRepo.repo, ["branch", "explicit-base"]);
		runGitChecked(explicitRepo.repo, ["checkout", "explicit-base"]);
		writeFileSync(join(explicitRepo.repo, "explicit.txt"), "explicit\n");
		runGitChecked(explicitRepo.repo, ["add", "explicit.txt"]);
		runGitChecked(explicitRepo.repo, ["commit", "--no-gpg-sign", "-m", "explicit"]);
		runGitChecked(explicitRepo.repo, ["checkout", "main"]);
		explicitSetup = createWorktrees(explicitRepo.repo, "base/explicit", 1, { baseBranch: "explicit-base", symlinkDirectories: [] });
		assert.equal(runGitChecked(explicitSetup.worktrees[0]!.path, ["rev-parse", "HEAD"]).trim(), runGitChecked(explicitRepo.repo, ["rev-parse", "explicit-base"]).trim());
	} finally {
		if (explicitSetup) cleanupWorktrees(explicitSetup);
		rmSync(explicitRepo.root, { recursive: true, force: true });
	}

	const fallbackRepo = createRepository();
	let fallbackSetup: ReturnType<typeof createWorktrees> | undefined;
	try {
		fallbackSetup = createWorktrees(fallbackRepo.repo, "base/head", 1, { symlinkDirectories: [] });
		assert.equal(runGitChecked(fallbackSetup.worktrees[0]!.path, ["rev-parse", "HEAD"]).trim(), runGitChecked(fallbackRepo.repo, ["rev-parse", "HEAD"]).trim());
	} finally {
		if (fallbackSetup) cleanupWorktrees(fallbackSetup);
		rmSync(fallbackRepo.root, { recursive: true, force: true });
	}
});
test("subagent worktrees use the same linked-invocation lifecycle", () => {
	const { root, repo } = createRepository();
	const linked = join(root, "subagent-linked");
	let setup;
	try {
		runGitChecked(repo, ["worktree", "add", "--detach", linked]);
		setup = createSubagentWorktrees(linked, "subagent/nested", 1);
		assert.equal(setup.worktrees[0]!.path, join(repo, ".atomic", "worktrees", "subagent+nested-0"));
		assert.equal(setup.worktrees[0]!.branch, "worktree-subagent+nested-0");
	} finally {
		if (setup) cleanupSubagentWorktrees(setup);
		assert.equal(runGitChecked(repo, ["branch", "--list", "worktree-subagent+nested-0"]).trim(), "");
		rmSync(root, { recursive: true, force: true });
	}
});

unixTest("post-creation setup failure removes the worktree and branch", () => {
	const { root, repo } = createRepository();
	const hook = join(root, "bad-hook.sh");
	writeFileSync(hook, "#!/bin/sh\nprintf 'not-json'\n");
	chmodSync(hook, 0o755);
	try {
		assert.throws(() => createWorktrees(repo, "failed/setup", 1, {
			baseBranch: "main",
			setupHook: { hookPath: hook },
		}), /invalid JSON/);
		assert.equal(existsSync(join(repo, ".atomic", "worktrees", "failed+setup-0")), false);
		assert.equal(runGitChecked(repo, ["branch", "--list", "worktree-failed+setup-0"]).trim(), "");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

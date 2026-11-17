import { test } from "vitest";

// The setup-hook failure contract executes a bash-shebang script directly,
// which Windows cannot spawn; the error-path contract runs on unix jobs.
const unixTest = process.platform === "win32" ? test.skip : test;

import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupWorktrees as cleanupSubagentWorktrees,
	createWorktrees as createSubagentWorktrees,
	isSpuriousHookStdinWriteFailure as isSpuriousSubagentStdinWriteFailure,
} from "../../packages/subagents/src/runs/shared/worktree.js";
import { diffWorktrees } from "../../packages/workflows/src/runs/shared/worktree-diff.js";
import { runGit, runGitChecked, runGitPlain } from "../../packages/workflows/src/runs/shared/worktree-git.js";
import {
	cleanupWorktrees,
	createWorktrees,
	isSpuriousHookStdinWriteFailure as isSpuriousWorkflowStdinWriteFailure,
} from "../../packages/workflows/src/runs/shared/worktree-setup.js";

async function createRepository(ignoreSettings = true): Promise<{ root: string; repo: string }> {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-worktree-lifecycle-")));
	const repo = join(root, "repo");
	mkdirSync(repo);
	await runGitChecked(repo, ["init", "-b", "main"]);
	await runGitChecked(repo, ["config", "user.name", "Atomic Test"]);
	await runGitChecked(repo, ["config", "user.email", "atomic@example.com"]);
	writeFileSync(
		join(repo, ".gitignore"),
		[
			...(ignoreSettings ? [".atomic/settings.local.json", ".atomic/settings.json"] : []),
			"ignored/",
			"deps/",
			"",
		].join("\n"),
	);
	writeFileSync(join(repo, ".worktreeinclude"), "ignored/**/*.txt\n");
	mkdirSync(join(repo, "packages", "api"), { recursive: true });
	writeFileSync(join(repo, "packages", "api", "tracked.txt"), "tracked\n");
	await runGitChecked(repo, ["add", "."]);
	await runGitChecked(repo, ["commit", "--no-gpg-sign", "-m", "initial"]);
	return { root, repo };
}

test("temporary worktree uses main-root path, flattened branch, and post-creation setup", async () => {
	const { root, repo } = await createRepository();
	mkdirSync(join(repo, ".atomic"), { recursive: true });
	writeFileSync(join(repo, ".atomic", "settings.local.json"), '{"local":true}\n');
	writeFileSync(join(repo, ".atomic", "settings.json"), '{"shared":true}\n');
	mkdirSync(join(repo, "ignored", "nested"), { recursive: true });
	writeFileSync(join(repo, "ignored", "nested", "secret.txt"), "included\n");
	writeFileSync(join(repo, "ignored", "skip.log"), "excluded\n");
	mkdirSync(join(repo, "deps"));
	writeFileSync(join(repo, "deps", "module.txt"), "dependency\n");
	let setup: Awaited<ReturnType<typeof createWorktrees>> | undefined;
	try {
		setup = await createWorktrees(join(repo, "packages", "api"), "feature/name", 1, {
			baseBranch: "main",
			symlinkDirectories: ["deps"],
		});
		const worktree = setup.worktrees[0]!;
		assert.equal(worktree.path, join(repo, ".atomic", "worktrees", "feature+name-0"));
		assert.equal(worktree.agentCwd, join(worktree.path, "packages", "api"));
		assert.equal(worktree.branch, "worktree-feature+name-0");
		assert.equal((await runGitChecked(worktree.path, ["branch", "--show-current"])).trim(), worktree.branch);
		assert.equal(readFileSync(join(worktree.path, ".atomic", "settings.local.json"), "utf8"), '{"local":true}\n');
		assert.equal(readFileSync(join(worktree.path, ".atomic", "settings.json"), "utf8"), '{"shared":true}\n');
		assert.equal(readFileSync(join(worktree.path, "ignored", "nested", "secret.txt"), "utf8"), "included\n");
		assert.equal(existsSync(join(worktree.path, "ignored", "skip.log")), false);
		assert.equal(lstatSync(join(worktree.path, "deps")).isSymbolicLink(), true);
	} finally {
		if (setup) await cleanupWorktrees(setup);
		assert.equal((await runGitChecked(repo, ["branch", "--list", "worktree-feature+name-0"])).trim(), "");
		rmSync(root, { recursive: true, force: true });
	}
});

// On Windows the linked directory is a real junction, which Git for Windows either
// leaves behind (keeping the worktree) or follows into the main checkout.
test("cleanup removes a worktree with a linked directory and keeps the main checkout's copy", async () => {
	const { root, repo } = await createRepository();
	mkdirSync(join(repo, "deps"));
	writeFileSync(join(repo, "deps", "module.txt"), "dependency\n");
	let setup: Awaited<ReturnType<typeof createWorktrees>> | undefined;
	try {
		setup = await createWorktrees(repo, "linked/cleanup", 1, { baseBranch: "main", symlinkDirectories: ["deps"] });
		const worktree = setup.worktrees[0]!;
		assert.equal(lstatSync(join(worktree.path, "deps")).isSymbolicLink(), true);
		await cleanupWorktrees(setup);
		setup = undefined;
		assert.equal(existsSync(worktree.path), false, "the worktree directory must be deleted");
		assert.equal(readFileSync(join(repo, "deps", "module.txt"), "utf8"), "dependency\n");
		assert.equal((await runGitChecked(repo, ["branch", "--list", worktree.branch])).trim(), "");
	} finally {
		if (setup) await cleanupWorktrees(setup);
		rmSync(root, { recursive: true, force: true });
	}
});

test("setup rollback removes a worktree with a linked directory and keeps the main checkout's copy", async () => {
	const { root, repo } = await createRepository();
	mkdirSync(join(repo, "deps"));
	writeFileSync(join(repo, "deps", "module.txt"), "dependency\n");
	// Not executable on any platform, so the hook fails after the directory was linked.
	const hook = join(root, "not-executable.txt");
	writeFileSync(hook, "not a program\n");
	try {
		await assert.rejects(
			async () =>
				await createWorktrees(repo, "linked/rollback", 1, {
					baseBranch: "main",
					symlinkDirectories: ["deps"],
					setupHook: { hookPath: hook },
				}),
			/worktree setup hook failed/,
		);
		assert.equal(existsSync(join(repo, ".atomic", "worktrees", "linked+rollback-0")), false);
		assert.equal(readFileSync(join(repo, "deps", "module.txt"), "utf8"), "dependency\n");
		assert.equal((await runGitChecked(repo, ["branch", "--list", "worktree-linked+rollback-0"])).trim(), "");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("non-ignored local settings propagate without leaking into patches and repeated creation stays usable", async () => {
	const { root, repo } = await createRepository(false);
	const diffs = join(root, "diffs");
	mkdirSync(join(repo, ".atomic"), { recursive: true });
	writeFileSync(join(repo, ".atomic", "settings.local.json"), '{"secret":true}\n');
	writeFileSync(join(repo, ".atomic", "settings.json"), '{"local":true}\n');
	let first: Awaited<ReturnType<typeof createWorktrees>> | undefined;
	let second: Awaited<ReturnType<typeof createWorktrees>> | undefined;
	try {
		first = await createWorktrees(repo, "settings/first", 1, { baseBranch: "main", symlinkDirectories: [] });
		assert.equal(
			readFileSync(join(first.worktrees[0]!.path, ".atomic", "settings.local.json"), "utf8"),
			'{"secret":true}\n',
		);
		writeFileSync(join(first.worktrees[0]!.path, "agent-change.txt"), "agent\n");
		const [diff] = await diffWorktrees(first, ["worker"], diffs);
		assert.ok(diff);
		assert.doesNotMatch(readFileSync(diff.patchPath, "utf8"), /settings\.(?:local\.)?json|secret/);
		await cleanupWorktrees(first);
		first = undefined;
		assert.equal(readFileSync(join(repo, ".atomic", "worktrees", ".gitignore"), "utf8"), "*\n");
		second = await createWorktrees(repo, "settings/second", 1, { baseBranch: "main", symlinkDirectories: [] });
		assert.equal(existsSync(second.worktrees[0]!.path), true);
		writeFileSync(join(repo, "packages", "api", "tracked.txt"), "modified\n");
		await assert.rejects(async () => await createWorktrees(repo, "tracked/dirty", 1), /clean git working tree/);
	} finally {
		if (first) await cleanupWorktrees(first);
		if (second) await cleanupWorktrees(second);
		rmSync(root, { recursive: true, force: true });
	}
});
test("linked-worktree invocation anchors temporary worktrees at the main root", async () => {
	const { root, repo } = await createRepository();
	const linked = join(root, "linked-source");
	let setup: Awaited<ReturnType<typeof createWorktrees>> | undefined;
	try {
		await runGitChecked(repo, ["worktree", "add", "--detach", linked]);
		setup = await createWorktrees(join(linked, "packages", "api"), "inside/linked", 1, { baseBranch: "main" });
		const created = setup.worktrees[0]!;
		assert.equal(created.path, join(repo, ".atomic", "worktrees", "inside+linked-0"));
		assert.equal(created.agentCwd, join(created.path, "packages", "api"));
		assert.equal(created.branch, "worktree-inside+linked-0");
	} finally {
		if (setup) await cleanupWorktrees(setup);
		assert.equal((await runGitChecked(repo, ["branch", "--list", "worktree-inside+linked-0"])).trim(), "");
		rmSync(root, { recursive: true, force: true });
	}
});
test("default base ref fetches a missing origin default branch", async () => {
	const { root, repo } = await createRepository();
	const remote = join(root, "remote.git");
	let setup: Awaited<ReturnType<typeof createWorktrees>> | undefined;
	try {
		mkdirSync(remote);
		await runGitChecked(remote, ["init", "--bare", "--initial-branch=main"]);
		await runGitChecked(repo, ["remote", "add", "origin", remote]);
		await runGitChecked(repo, ["push", "-u", "origin", "main"]);
		await runGitChecked(repo, ["remote", "set-head", "origin", "main"]);
		const remoteCommit = (await runGitChecked(repo, ["rev-parse", "origin/main"])).trim();
		writeFileSync(join(repo, "local-only.txt"), "local\n");
		await runGitChecked(repo, ["add", "local-only.txt"]);
		await runGitChecked(repo, ["commit", "--no-gpg-sign", "-m", "local ahead"]);
		await runGitChecked(repo, ["update-ref", "-d", "refs/remotes/origin/main"]);
		assert.notEqual((await runGit(repo, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"])).status, 0);
		setup = await createWorktrees(repo, "remote-default", 1);
		assert.equal((await runGitChecked(setup.worktrees[0]!.path, ["rev-parse", "HEAD"])).trim(), remoteCommit);
		assert.equal(
			(await runGitChecked(repo, ["show-ref", "--verify", "refs/remotes/origin/main"])).trim().length > 0,
			true,
		);
	} finally {
		if (setup) await cleanupWorktrees(setup);
		rmSync(root, { recursive: true, force: true });
	}
});

test("post-creation setup writes exact hooks paths and skips an already-correct write", async () => {
	const huskyRepo = await createRepository();
	let first: Awaited<ReturnType<typeof createWorktrees>> | undefined;
	let second: Awaited<ReturnType<typeof createWorktrees>> | undefined;
	try {
		mkdirSync(join(huskyRepo.repo, ".husky"));
		first = await createWorktrees(huskyRepo.repo, "hooks/husky", 1, { baseBranch: "main", symlinkDirectories: [] });
		assert.equal(
			(await runGitPlain(huskyRepo.repo, ["config", "--get", "core.hooksPath"])).stdout.trim(),
			join(huskyRepo.repo, ".husky"),
		);
		await cleanupWorktrees(first);
		first = undefined;
		const configBefore = readFileSync(join(huskyRepo.repo, ".git", "config"), "utf8");
		second = await createWorktrees(huskyRepo.repo, "hooks/idempotent", 1, {
			baseBranch: "main",
			symlinkDirectories: [],
		});
		assert.equal(readFileSync(join(huskyRepo.repo, ".git", "config"), "utf8"), configBefore);
	} finally {
		if (first) await cleanupWorktrees(first);
		if (second) await cleanupWorktrees(second);
		rmSync(huskyRepo.root, { recursive: true, force: true });
	}

	const nativeRepo = await createRepository();
	let nativeSetup: Awaited<ReturnType<typeof createWorktrees>> | undefined;
	try {
		writeFileSync(join(nativeRepo.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
		nativeSetup = await createWorktrees(nativeRepo.repo, "hooks/native", 1, {
			baseBranch: "main",
			symlinkDirectories: [],
		});
		assert.equal(
			(await runGitPlain(nativeRepo.repo, ["config", "--get", "core.hooksPath"])).stdout.trim(),
			join(nativeRepo.repo, ".git", "hooks"),
		);
	} finally {
		if (nativeSetup) await cleanupWorktrees(nativeSetup);
		rmSync(nativeRepo.root, { recursive: true, force: true });
	}
});

test("temporary base ref precedence is explicit then origin default then HEAD", async () => {
	const explicitRepo = await createRepository();
	let explicitSetup: Awaited<ReturnType<typeof createWorktrees>> | undefined;
	try {
		await runGitChecked(explicitRepo.repo, ["branch", "explicit-base"]);
		await runGitChecked(explicitRepo.repo, ["checkout", "explicit-base"]);
		writeFileSync(join(explicitRepo.repo, "explicit.txt"), "explicit\n");
		await runGitChecked(explicitRepo.repo, ["add", "explicit.txt"]);
		await runGitChecked(explicitRepo.repo, ["commit", "--no-gpg-sign", "-m", "explicit"]);
		await runGitChecked(explicitRepo.repo, ["checkout", "main"]);
		explicitSetup = await createWorktrees(explicitRepo.repo, "base/explicit", 1, {
			baseBranch: "explicit-base",
			symlinkDirectories: [],
		});
		assert.equal(
			(await runGitChecked(explicitSetup.worktrees[0]!.path, ["rev-parse", "HEAD"])).trim(),
			(await runGitChecked(explicitRepo.repo, ["rev-parse", "explicit-base"])).trim(),
		);
	} finally {
		if (explicitSetup) await cleanupWorktrees(explicitSetup);
		rmSync(explicitRepo.root, { recursive: true, force: true });
	}

	const fallbackRepo = await createRepository();
	let fallbackSetup: Awaited<ReturnType<typeof createWorktrees>> | undefined;
	try {
		fallbackSetup = await createWorktrees(fallbackRepo.repo, "base/head", 1, { symlinkDirectories: [] });
		assert.equal(
			(await runGitChecked(fallbackSetup.worktrees[0]!.path, ["rev-parse", "HEAD"])).trim(),
			(await runGitChecked(fallbackRepo.repo, ["rev-parse", "HEAD"])).trim(),
		);
	} finally {
		if (fallbackSetup) await cleanupWorktrees(fallbackSetup);
		rmSync(fallbackRepo.root, { recursive: true, force: true });
	}
});
test("subagent worktrees use the same linked-invocation lifecycle", async () => {
	const { root, repo } = await createRepository();
	const linked = join(root, "subagent-linked");
	let setup: Awaited<ReturnType<typeof createSubagentWorktrees>> | undefined;
	try {
		await runGitChecked(repo, ["worktree", "add", "--detach", linked]);
		setup = await createSubagentWorktrees(linked, "subagent/nested", 1);
		assert.equal(setup.worktrees[0]!.path, join(repo, ".atomic", "worktrees", "subagent+nested-0"));
		assert.equal(setup.worktrees[0]!.branch, "worktree-subagent+nested-0");
	} finally {
		if (setup) await cleanupSubagentWorktrees(setup);
		assert.equal((await runGitChecked(repo, ["branch", "--list", "worktree-subagent+nested-0"])).trim(), "");
		rmSync(root, { recursive: true, force: true });
	}
});

unixTest("post-creation setup failure removes the worktree and branch", async () => {
	const { root, repo } = await createRepository();
	const hook = join(root, "bad-hook.sh");
	writeFileSync(hook, "#!/bin/sh\nprintf 'not-json'\n");
	chmodSync(hook, 0o755);
	try {
		await assert.rejects(
			async () =>
				await createWorktrees(repo, "failed/setup", 1, {
					baseBranch: "main",
					setupHook: { hookPath: hook },
				}),
			/invalid JSON/,
		);
		assert.equal(existsSync(join(repo, ".atomic", "worktrees", "failed+setup-0")), false);
		assert.equal((await runGitChecked(repo, ["branch", "--list", "worktree-failed+setup-0"])).trim(), "");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * The stdin-write race that made "post-creation setup failure" above fail on a
 * loaded CI runner: the hook exits before the parent finishes writing its JSON
 * input, so `spawnSync` reports EPIPE even though the hook ran and its stdout
 * was captured in full. Whether the race is lost depends on machine load, so it
 * is the decision that gets asserted here rather than a timing-dependent spawn.
 * Both worktree implementations carry their own copy and must agree.
 */
for (const [pkg, isSpurious] of [
	["workflows", isSpuriousWorkflowStdinWriteFailure],
	["subagents", isSpuriousSubagentStdinWriteFailure],
] as const) {
	test(`${pkg}: a hook that ignored stdin stays authoritative through its exit status`, () => {
		// The hook ran to completion; only the parent's unread write failed.
		assert.equal(isSpurious("EPIPE", 0), true);
		assert.equal(isSpurious("EPIPE", 1), true, "a real non-zero exit must still reach the exit-code branch");
		// No status means the child never ran, so EPIPE is all the evidence there is.
		assert.equal(isSpurious("EPIPE", null), false);
		// Every other spawn failure stays fatal.
		assert.equal(isSpurious("ENOENT", null), false);
		assert.equal(isSpurious("EACCES", 0), false);
		assert.equal(isSpurious(undefined, 0), false);
	});
}

/**
 * End to end: a hook that never reads its stdin must still have its work and its
 * stdout honored, in either ordering of that race.
 */
unixTest("a setup hook that never reads stdin still has its output honored", async () => {
	const { root, repo } = await createRepository();
	const hook = join(root, "deaf-hook.sh");
	// Closes stdin outright, so the parent's write has no reader at all.
	writeFileSync(hook, '#!/bin/sh\nexec 0<&-\nmkdir -p generated\nprintf \'{"syntheticPaths":["generated"]}\'\n');
	chmodSync(hook, 0o755);
	let setup: Awaited<ReturnType<typeof createWorktrees>> | undefined;
	try {
		setup = await createWorktrees(repo, "deaf/hook", 1, {
			baseBranch: "main",
			setupHook: { hookPath: hook },
		});
		const worktree = setup.worktrees[0]!;
		assert.equal(existsSync(join(worktree.path, "generated")), true, "the hook's real work was discarded");
		assert.ok(
			worktree.syntheticPaths?.includes("generated"),
			"the hook's stdout must still be parsed when only the stdin write failed",
		);
	} finally {
		if (setup) await cleanupWorktrees(setup);
		rmSync(root, { recursive: true, force: true });
	}
});

unixTest("subagent setup hooks receive Atomic attribution in a real child", async () => {
	const { root, repo } = await createRepository();
	const hook = join(root, "subagent-env-hook.sh");
	const output = join(root, "subagent-env.txt");
	writeFileSync(
		hook,
		`#!/bin/sh
cat >/dev/null
printf '%s' "$AI_AGENT" > '${output.replaceAll("'", "'\\''")}'
printf '{}'
`,
	);
	chmodSync(hook, 0o755);
	let setup: Awaited<ReturnType<typeof createSubagentWorktrees>> | undefined;
	const previousAiAgent = process.env.AI_AGENT;
	process.env.AI_AGENT = "caller";
	try {
		setup = await createSubagentWorktrees(repo, "env/subagent-hook", 1, { setupHook: { hookPath: hook } });
		assert.equal(readFileSync(output, "utf8"), "atomic");
	} finally {
		if (setup) await cleanupSubagentWorktrees(setup);
		if (previousAiAgent === undefined) delete process.env.AI_AGENT;
		else process.env.AI_AGENT = previousAiAgent;
		rmSync(root, { recursive: true, force: true });
	}
});

unixTest("workflow setup hooks receive Atomic attribution in a real child", async () => {
	const { root, repo } = await createRepository();
	const hook = join(root, "workflow-env-hook.sh");
	const output = join(root, "workflow-env.txt");
	writeFileSync(
		hook,
		`#!/bin/sh
cat >/dev/null
printf '%s' "$AI_AGENT" > '${output.replaceAll("'", "'\\''")}'
printf '{}'
`,
	);
	chmodSync(hook, 0o755);
	let setup: Awaited<ReturnType<typeof createWorktrees>> | undefined;
	const previousAiAgent = process.env.AI_AGENT;
	process.env.AI_AGENT = "caller";
	try {
		setup = await createWorktrees(repo, "env/workflow-hook", 1, {
			baseBranch: "main",
			setupHook: { hookPath: hook },
			symlinkDirectories: [],
		});
		assert.equal(readFileSync(output, "utf8"), "atomic");
	} finally {
		if (setup) await cleanupWorktrees(setup);
		if (previousAiAgent === undefined) delete process.env.AI_AGENT;
		else process.env.AI_AGENT = previousAiAgent;
		rmSync(root, { recursive: true, force: true });
	}
});

unixTest("worktree setup hooks settle on timeout when a background grandchild holds stdio (#5377)", async () => {
	const { root, repo } = await createRepository();
	const hook = join(root, "grandchild-hook.sh");
	const pidFile = join(root, "grandchild.pid");
	writeFileSync(
		hook,
		`#!/bin/sh\ntrap '' TERM\n(trap '' TERM; sleep 30) &\necho $! > '${pidFile.replaceAll("'", "'\\''")}'\nsleep 30\n`,
	);
	chmodSync(hook, 0o755);
	const within = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("setup hook hung on grandchild pipe")), ms);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	};
	const waitForProcessExit = async (pid: number): Promise<void> => {
		for (let i = 0; i < 50; i++) {
			try {
				process.kill(pid, 0);
			} catch {
				return;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
		}
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	};
	try {
		await assert.rejects(
			() =>
				within(
					createWorktrees(repo, "timeout/workflow-hook", 1, {
						baseBranch: "main",
						setupHook: { hookPath: hook, timeoutMs: 150 },
						symlinkDirectories: [],
					}),
					2_000,
				),
			/worktree setup hook timed out after 150ms/,
		);
		await waitForProcessExit(Number(readFileSync(pidFile, "utf8").trim()));

		await assert.rejects(
			() =>
				within(
					createSubagentWorktrees(repo, "timeout/subagent-hook", 1, {
						setupHook: { hookPath: hook, timeoutMs: 150 },
					}),
					2_000,
				),
			/worktree setup hook timed out after 150ms/,
		);
		await waitForProcessExit(Number(readFileSync(pidFile, "utf8").trim()));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

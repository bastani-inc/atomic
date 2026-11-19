import { test } from "vitest";

// The setup-hook failure contract executes a bash-shebang script directly,
// which Windows cannot spawn; the error-path contract runs on unix jobs.
const unixTest = process.platform === "win32" ? test.skip : test;

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupWorktrees as cleanupSubagentWorktrees,
	createWorktrees as createSubagentWorktrees,
	isSpuriousHookStdinWriteFailure as isSpuriousSubagentStdinWriteFailure,
	runGitChecked,
} from "../../packages/subagents/src/runs/shared/worktree.js";

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

test("a subagent hook that ignored stdin stays authoritative through its exit status", () => {
	// The hook ran to completion; only the parent's unread write failed.
	assert.equal(isSpuriousSubagentStdinWriteFailure("EPIPE", 0), true);
	assert.equal(
		isSpuriousSubagentStdinWriteFailure("EPIPE", 1),
		true,
		"a real non-zero exit must still reach the exit-code branch",
	);
	// No status means the child never ran, so EPIPE is all the evidence there is.
	assert.equal(isSpuriousSubagentStdinWriteFailure("EPIPE", null), false);
	// Every other spawn failure stays fatal.
	assert.equal(isSpuriousSubagentStdinWriteFailure("ENOENT", null), false);
	assert.equal(isSpuriousSubagentStdinWriteFailure("EACCES", 0), false);
	assert.equal(isSpuriousSubagentStdinWriteFailure(undefined, 0), false);
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

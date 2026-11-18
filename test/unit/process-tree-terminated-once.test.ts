import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as realSleep } from "node:timers/promises";
import { afterEach, test, vi } from "vitest";

/**
 * Every process tree a caller contains is recorded on its own: what was done to it, in order. Terminating the job ends
 * every process in it on Windows; `endsOnTerminate` says whether this fake does that too, by killing the contained root.
 */
const containment = vi.hoisted(() => ({
	enabled: false,
	endsOnTerminate: true,
	trees: [] as { pid: number; events: string[] }[],
}));

vi.mock("../../packages/coding-agent/src/core/process-tree-containment.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../packages/coding-agent/src/core/process-tree-containment.ts")>();
	return {
		...actual,
		containProcessTree: (pid: number) => {
			if (!containment.enabled) return actual.containProcessTree(pid);
			const tree = { pid, events: ["contain"] };
			containment.trees.push(tree);
			return {
				terminate: () => {
					tree.events.push("terminate");
					if (containment.endsOnTerminate) {
						try {
							process.kill(pid, "SIGKILL");
						} catch {}
					}
					return true;
				},
				activeProcesses: () => 0,
				release: () => {
					tree.events.push("release");
					return true;
				},
				close: () => {
					tree.events.push("close");
				},
			};
		},
	};
});

import { resolveConfigValueUncachedAsync } from "../../packages/coding-agent/src/core/resolve-config-value.js";
import { openStepLog, runLoggedProcess } from "../../packages/coding-agent/src/core/resume/blueprint/process.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	type WorktreeSetup,
} from "../../packages/subagents/src/runs/shared/worktree.js";

const PROCESS_START_WAIT_MS = 20_000;

afterEach(() => {
	vi.useRealTimers();
	containment.enabled = false;
	containment.endsOnTerminate = true;
	containment.trees = [];
});

function terminatedTrees(): { pid: number; events: string[] }[] {
	return containment.trees.filter((tree) => tree.events.includes("terminate"));
}

async function waitForTermination(): Promise<{ pid: number; events: string[] }> {
	const deadline = Date.now() + PROCESS_START_WAIT_MS;
	while (terminatedTrees().length === 0) {
		assert.ok(Date.now() < deadline, "no process tree was terminated");
		await realSleep(10);
	}
	return terminatedTrees()[0]!;
}

function kill(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {}
}

// The command goes through the configured POSIX shell, which `exec` replaces, so the contained root is the command.
test.skipIf(process.platform === "win32")(
	"a config value command stopped for its output size has its process tree terminated once, also when its exit follows (#5601)",
	async () => {
		containment.enabled = true;
		const value = await resolveConfigValueUncachedAsync(
			`!exec node -e 'process.stdout.write("x".repeat(1100000)); setTimeout(() => {}, 30000)'`,
		);
		assert.equal(value, undefined);
		assert.deepEqual(
			terminatedTrees().map((tree) => tree.events),
			[["contain", "terminate", "close"]],
		);
	},
);

test("a blueprint step stopped by its timeout and then aborted has its process tree terminated once (#5601)", async () => {
	containment.enabled = true;
	// The fake job ends nothing here, so the abort still finds the step running after the timeout terminated it.
	containment.endsOnTerminate = false;
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "process-tree-once-step-")));
	const log = await openStepLog(join(directory, "step.log"));
	let rootPid = 0;
	try {
		const controller = new AbortController();
		const reason = new Error("resume cancelled");
		const pending = runLoggedProcess(
			{ command: process.execPath, args: ["-e", "setTimeout(() => {}, 60_000)"], cwd: directory, env: process.env },
			log,
			{ timeoutMs: 100, signal: controller.signal },
		);
		rootPid = (await waitForTermination()).pid;
		controller.abort(reason);
		kill(rootPid);
		await assert.rejects(pending, (error: unknown) => error === reason);
		assert.deepEqual(
			terminatedTrees().map((tree) => tree.events),
			[["contain", "terminate", "close"]],
		);
	} finally {
		if (rootPid > 0) kill(rootPid);
		await log.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

// A setup hook runs as an executable script with a shebang, which Windows cannot spawn.
test.skipIf(process.platform === "win32")(
	"a worktree setup hook stopped for its output size and then reached by its timeout has its process tree terminated once (#5601)",
	async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "process-tree-once-hook-")));
		const repo = join(root, "repo");
		mkdirSync(repo);
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
		git("init", "-b", "main");
		git("config", "user.name", "Atomic Test");
		git("config", "user.email", "atomic@example.com");
		writeFileSync(join(repo, "tracked.txt"), "tracked\n");
		git("add", ".");
		git("commit", "--no-gpg-sign", "-m", "initial");
		const hook = join(root, "loud-hook.sh");
		// One byte past the hook output limit, then a wait that outlives the test's own control of the timeout.
		writeFileSync(hook, "#!/bin/sh\nhead -c 67108865 /dev/zero\nexec sleep 60\n");
		chmodSync(hook, 0o755);
		let setup: WorktreeSetup | undefined;
		let hookPid = 0;
		containment.enabled = true;
		// The fake job ends nothing here, so the hook still runs when its timeout comes.
		containment.endsOnTerminate = false;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const creating = createWorktrees(repo, "hook/overflow", 1, {
				setupHook: { hookPath: hook, timeoutMs: 30_000 },
			});
			creating.then(
				(created) => {
					setup = created;
				},
				() => {},
			);
			hookPid = (await waitForTermination()).pid;
			await vi.advanceTimersByTimeAsync(30_000);
			vi.useRealTimers();
			kill(hookPid);
			await assert.rejects(creating, /ENOBUFS/);
			assert.deepEqual(
				terminatedTrees().map((tree) => tree.events),
				[["contain", "terminate", "close"]],
			);
		} finally {
			vi.useRealTimers();
			if (hookPid > 0) kill(hookPid);
			if (setup) await cleanupWorktrees(setup);
			rmSync(root, { recursive: true, force: true });
		}
	},
);

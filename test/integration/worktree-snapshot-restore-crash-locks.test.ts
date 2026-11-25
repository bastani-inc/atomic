import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { removeRestoredWorktree } from "../../packages/coding-agent/src/core/worktree-snapshot/index.js";
import { type SpawnedProcess, sleep } from "../helpers/runtime.js";
import {
	assertHealthy,
	child,
	fixture,
	RESTORE_CRASH_TIMEOUT_MS,
	RESTORE_LOCK_STALE_MS,
	result,
	retry,
	waitFor,
} from "./worktree-snapshot-restore-crash-helpers.js";

test.skipIf(process.platform === "win32").each([
	["", (id: string) => `.s-${id.replaceAll("-", "").slice(0, 12)}`],
	[" with an earlier version's long staging name (#5139)", (id: string) => `.staging-${id}`],
])(
	"a stale locked-initializing worktree is swept even when removal is the next operation (#4245)%s",
	async (_name, stagingName) => {
		const f = await fixture();
		try {
			const store = f.sandbox.path("host");
			const first = await retry(f, store);
			const repositories = join(store, "repositories");
			const repo = join(repositories, readdirSync(repositories)[0]!);
			const id = randomUUID();
			const staging = join(store, "worktrees", stagingName(id));
			const target = join(store, "worktrees", `unused-${id}`);
			await f.sandbox.git(
				f.sandbox.root,
				"--git-dir",
				repo,
				"worktree",
				"add",
				"-q",
				"--detach",
				"--no-checkout",
				staging,
				f.snapshot.head,
			);
			await f.sandbox.git(
				f.sandbox.root,
				"--git-dir",
				repo,
				"worktree",
				"lock",
				"--reason",
				"initializing",
				staging,
			);
			mkdirSync(join(store, "restores"), { recursive: true });
			writeFileSync(
				join(store, "restores", `${id}.json`),
				JSON.stringify({ staging, target, store: repo, createdTarget: true }),
			);
			await removeRestoredWorktree(f.sandbox.path("does-not-exist"), { storeDir: store });
			assert.equal(existsSync(staging), false);
			await assertHealthy(f, store, [first]);
		} finally {
			f.sandbox.dispose();
		}
	},
	RESTORE_CRASH_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a concurrent restore never sweeps another process's live staging worktree (#4245)",
	async () => {
		const f = await fixture();
		let paused: SpawnedProcess | undefined;
		try {
			const store = f.sandbox.path("host");
			paused = child(f, store, "pause");
			await waitFor(f.ready);
			const first = await retry(f, store);
			writeFileSync(f.go, "continue");
			const resumed = await result(paused);
			assert.equal(resumed.exit, 0, resumed.stderr);
			paused = undefined;
			const second = (JSON.parse(resumed.stdout) as { path: string }).path;
			await assertHealthy(f, store, [first, second]);
		} finally {
			if (paused) {
				paused.kill("SIGKILL");
				await paused.exited;
			}
			f.sandbox.dispose();
		}
	},
	RESTORE_CRASH_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a restore stopped past its lock's stale window is swept and fails typed when resumed (#4245)",
	async () => {
		const f = await fixture();
		let stopped: SpawnedProcess | undefined;
		try {
			const store = f.sandbox.path("host");
			stopped = child(f, store, "stop");
			await waitFor(f.ready);
			await sleep(RESTORE_LOCK_STALE_MS + 2_000);
			const recovered = await retry(f, store);
			writeFileSync(f.go, "continue");
			stopped.kill("SIGCONT");
			const resumed = await result(stopped);
			stopped = undefined;
			assert.equal(resumed.exit, 1, resumed.stderr);
			const error = JSON.parse(resumed.stderr) as { name: string; code: string; hint: string };
			assert.equal(error.name, "WorkspaceGitError");
			assert.equal(error.code, "git-failed");
			assert.ok(error.hint);
			await assertHealthy(f, store, [recovered]);
		} finally {
			if (stopped) {
				stopped.kill("SIGCONT");
				stopped.kill("SIGKILL");
				await stopped.exited;
			}
			f.sandbox.dispose();
		}
	},
	RESTORE_CRASH_TIMEOUT_MS,
);

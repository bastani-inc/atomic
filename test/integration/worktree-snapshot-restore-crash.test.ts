import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import {
	removeRestoredWorktree,
	verifyWorktree,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.js";
import {
	ageLocks,
	assertSigkillRestorePhases,
	child,
	fixture,
	RESTORE_CRASH_TIMEOUT_MS,
	result,
} from "./worktree-snapshot-restore-crash-helpers.js";

test.skipIf(process.platform === "win32")(
	"SIGKILL during worktree add and checkout leaves no unverified published worktree and stale staging is swept (#4245)",
	async () => {
		await assertSigkillRestorePhases(["add", "checkout"], 100);
	},
	RESTORE_CRASH_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"an interrupted restore into an existing empty directory recreates it before the retry (#4245)",
	async () => {
		const f = await fixture();
		try {
			const store = f.sandbox.path("host");
			const into = f.sandbox.path("existing-empty");
			mkdirSync(into);
			const killed = child(f, store, "move", into);
			await result(killed);
			assert.equal(killed.signalCode, "SIGKILL");
			assert.equal(
				existsSync(into),
				false,
				"the process stopped between removing the empty target and moving staging",
			);
			ageLocks(store);
			await removeRestoredWorktree(f.sandbox.path("does-not-exist"), { storeDir: store });
			assert.deepEqual(readdirSync(into), [], "recovery recreated the original empty directory");
			const resumed = await result(child(f, store, "none", into));
			assert.equal(resumed.exit, 0, resumed.stderr);
			assert.equal((JSON.parse(resumed.stdout) as { path: string }).path, into);
			assert.equal((await verifyWorktree(f.snapshot, into)).tree, f.snapshot.tree);
			assert.equal(readFileSync(join(into, "dirty.txt"), "utf8"), "recorded\n");
			assert.deepEqual(readdirSync(join(store, "restores")), []);
		} finally {
			f.sandbox.dispose();
		}
	},
	RESTORE_CRASH_TIMEOUT_MS,
);

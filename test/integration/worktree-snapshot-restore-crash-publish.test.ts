import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import {
	assertSigkillRestorePhases,
	child,
	fixture,
	RESTORE_CRASH_TIMEOUT_MS,
	result,
} from "./worktree-snapshot-restore-crash-helpers.js";

test.skipIf(process.platform === "win32")(
	"SIGKILL during worktree move and bundle fetch leaves no unverified published worktree and stale staging is swept (#4245)",
	async () => {
		await assertSigkillRestorePhases(["move", "bundle"], 100);
	},
	RESTORE_CRASH_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a target created during publication is never returned as the verified worktree (#4245)",
	async () => {
		const f = await fixture();
		try {
			const store = f.sandbox.path("host");
			const into = f.sandbox.path("target");
			const raced = await result(child(f, store, "race", into));
			assert.equal(raced.exit, 1, raced.stderr);
			const error = JSON.parse(raced.stderr) as { name: string; code: string };
			assert.equal(error.name, "WorkspaceRestoreError");
			assert.equal(error.code, "unsafe-target");
			assert.deepEqual(readdirSync(into), ["keep.txt"]);
			assert.equal(readFileSync(join(into, "keep.txt"), "utf8"), "user data\n");
			assert.deepEqual(readdirSync(join(store, "restores")), []);
		} finally {
			f.sandbox.dispose();
		}
	},
	RESTORE_CRASH_TIMEOUT_MS,
);

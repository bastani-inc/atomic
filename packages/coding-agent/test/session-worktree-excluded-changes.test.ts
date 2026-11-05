import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, describe, test } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import type { WorktreeSnapshotEntry } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { resumeSessionWorktree, SessionWorktreeSnapshotRecorder } from "../src/core/session-worktree-snapshots.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

async function sqlStore(): Promise<SqlSessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

const settings = { ...DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, maxFileBytes: 1000 };
const snapshotEntries = (manager: SessionManager): WorktreeSnapshotEntry[] =>
	manager.getEntries().filter((entry): entry is WorktreeSnapshotEntry => entry.type === "worktree_snapshot");
const writeTurn = (path: string) =>
	fauxAssistantMessage([fauxToolCall("write", { path, content: "" })], { stopReason: "toolUse" });

async function recorded(clone: string) {
	const manager = await SessionManager.create(await sqlStore(), clone);
	const recorder = new SessionWorktreeSnapshotRecorder({
		sessionManager: manager,
		cwd: () => clone,
		settings: () => settings,
		declaresWrites: () => false,
		onUnavailable: () => {},
	});
	return { manager, recorder };
}

describe("sessions and content the snapshot leaves out (#4245)", () => {
	test("a resume restores, rather than continuing in place, when a recorded file grew past the cap", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const { manager, recorder } = await recorded(clone);
		sandbox.write(join(clone, "data.json"), "x".repeat(500));
		await recorder.recordTurn(writeTurn(join(clone, "data.json")));
		sandbox.write(join(clone, "data.json"), "y".repeat(3000));
		const resume = await resumeSessionWorktree(manager, { settings, storeDir: sandbox.path("host") });
		assert.equal(resume.status, "restored");
		assert.notEqual(resume.cwd, clone);
		assert.equal(readFileSync(join(resume.cwd, "data.json"), "utf8"), "x".repeat(500));
	});

	test("a turn that only adds a denied file records a new snapshot naming it", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const { manager, recorder } = await recorded(clone);
		sandbox.write(join(clone, "a.txt"), "a\n");
		await recorder.recordTurn(writeTurn(join(clone, "a.txt")));
		sandbox.write(join(clone, ".env.local"), "TOKEN=1\n");
		await recorder.recordTurn(writeTurn(join(clone, ".env.local")));
		const snapshots = snapshotEntries(manager).map((entry) => entry.snapshot);
		assert.equal(snapshots.length, 2);
		assert.equal(snapshots[1]?.tree, snapshots[0]?.tree);
		assert.notEqual(snapshots[1]?.id, snapshots[0]?.id);
		assert.deepEqual(snapshots[1]?.omitted, [{ reason: "denied", path: ".env.local" }]);
	});
});

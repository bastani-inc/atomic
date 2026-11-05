import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { parseArgs } from "../src/cli/args.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { openSessionInWorktree, sessionContinuesIn } from "../src/core/session-worktree-snapshots.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import { createSessionManager } from "../src/main-session.ts";

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

test("opening a restored session by id from its new worktree resumes it instead of offering a fork (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	writeFileSync(join(clone, "notes.txt"), "recorded\n");
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	const manager = await SessionManager.create(store, clone);
	const capture = await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs });
	if (capture.status !== "captured") throw new Error("expected a snapshot");
	await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
	writeFileSync(join(clone, "notes.txt"), "drifted\n");
	const opened = await openSessionInWorktree(manager, {
		settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		storeDir: sandbox.path("host"),
	});
	const restored = opened.sessionManager.getCwd();
	assert.notEqual(restored, clone);

	assert.equal(await sessionContinuesIn(store, manager.getSessionId(), restored), true);
	assert.equal(await sessionContinuesIn(store, manager.getSessionId(), clone), false);
	assert.equal(await sessionContinuesIn(store, manager.getSessionId(), sandbox.root), false);

	const engine = await createSessionManager(
		parseArgs(["--session", manager.getSessionId()]),
		restored,
		undefined,
		SettingsManager.inMemory(),
		store,
	);
	assert.equal(engine.getSessionId(), manager.getSessionId());
	assert.equal(engine.getCwd(), clone);
	const continued = await openSessionInWorktree(engine, {
		settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		storeDir: sandbox.path("host"),
	});
	assert.equal(continued.sessionManager.getCwd(), restored);
	assert.deepEqual(continued.notices, []);
});

test("a session without restores is not continued from another directory", async () => {
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	const manager = await SessionManager.create(store, sandbox.root);
	await manager.appendSessionInfo("plain");
	assert.equal(await sessionContinuesIn(store, manager.getSessionId(), sandbox.root), false);
});

import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.ts";
import type { SqliteDatabase } from "../src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { resetSnapshotCollectionScheduleForTesting } from "../src/core/worktree-snapshot/garbage.ts";
import { isWorkspaceConfigError, rehydrateWorkspaceError, snapshotBlob } from "../src/index.ts";
import { createHarness } from "./suite/harness.js";

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
	resetSnapshotCollectionScheduleForTesting();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	resetSnapshotCollectionScheduleForTesting();
	sandbox.dispose();
});

/** A session store whose database holds the collection's first read until `release` is called. */
async function gatedStore() {
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered = false;
	const gated: SqliteDatabase = {
		descriptor: database.descriptor,
		exec: (sql) => database.exec(sql),
		run: (sql, ...params) => database.run(sql, ...params),
		get: async (sql, ...params) => {
			if (sql.startsWith("SELECT id FROM snapshot_collection")) {
				entered = true;
				await released;
			}
			return database.get(sql, ...params);
		},
		all: (sql, ...params) => database.all(sql, ...params),
		transaction: (callback, options) => database.transaction(callback, options),
		close: () => database.close(),
	};
	const store = await SqlSessionStore.open(gated);
	cleanups.push(async () => {
		release();
		await database.close();
	});
	return { database, store, release, entered: () => entered };
}

test("closing a session starts a collection of its store's blobs and resolves without waiting for it (#4355)", async () => {
	const { database, store, release, entered } = await gatedStore();
	const orphan = snapshotBlob(new TextEncoder().encode("left by an abandoned capture"));
	await store.snapshotBlobs.putBlobs([orphan]);
	await database.run(`UPDATE ${store.snapshotBlobs.table} SET created_at = created_at - 7200`);
	const manager = await SessionManager.create(store, sandbox.root);
	const harness = await createHarness({ sessionManager: manager });

	await harness.cleanup();

	assert.equal(entered(), true, "the close started the collection");
	assert.ok(await store.snapshotBlobs.getBlob(orphan.hash), "the close resolved while the collection was held");
	release();
	await vi.waitFor(async () => assert.equal(await store.snapshotBlobs.getBlob(orphan.hash), undefined));
	await store.close();
});

test("an invalid collection setting is reported once as the typed snapshot reason when the session closes (#4355)", async () => {
	const { store, entered } = await gatedStore();
	const manager = await SessionManager.create(store, sandbox.root);
	const harness = await createHarness({
		sessionManager: manager,
		settings: { snapshots: { collectIntervalSeconds: 0 } },
	});

	await harness.cleanup();

	assert.equal(entered(), false);
	const reasons = harness
		.eventsOfType("worktree_snapshot_unavailable")
		.map((event) => rehydrateWorkspaceError(event.reason));
	assert.equal(reasons.length, 1);
	assert.ok(isWorkspaceConfigError(reasons[0]));
	assert.deepEqual(reasons[0].fields, {
		source: "settings",
		field: "snapshots.collectIntervalSeconds",
		expected: "a positive integer",
	});
	await store.close();
});

test("an unexpected failure while starting the collection fails the close with that step named, never silently (#4355)", async () => {
	const { store, entered } = await gatedStore();
	const manager = await SessionManager.create(store, sandbox.root);
	const harness = await createHarness({ sessionManager: manager });
	cleanups.push(() => harness.cleanup().catch(() => undefined));
	const failure = new Error("settings file unreadable");
	vi.spyOn(harness.settingsManager, "getWorktreeSnapshotSettings").mockImplementation(() => {
		throw failure;
	});

	await assert.rejects(harness.session.dispose(), (error: unknown) => {
		assert.ok(error instanceof AggregateError);
		assert.deepEqual(
			error.errors.map((step: Error) => [step.message, step.cause]),
			[["snapshot collection", failure]],
		);
		return true;
	});
	assert.equal(entered(), false);
	vi.restoreAllMocks();
	await store.close();
});

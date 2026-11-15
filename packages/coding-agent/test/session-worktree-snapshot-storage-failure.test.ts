import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, test } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	SessionWorktreeSnapshotRecorder,
	type WorktreeSnapshotUnavailable,
} from "../src/core/session-worktree-snapshots.ts";
import { StoragePayloadTooLargeError, StorageUnavailableError } from "../src/core/storage/errors.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

const writing = (path: string) =>
	fauxAssistantMessage([fauxToolCall("write", { path, content: "x" })], { stopReason: "toolUse" });

for (const failure of [
	() => new StorageUnavailableError({ adapter: "libsql", location: "http://db" }, new Error("connection reset")),
	() =>
		new StoragePayloadTooLargeError(5_000_000, 6_000_000, {
			descriptor: { adapter: "libsql", location: "http://db" },
		}),
]) {
	test(`a turn whose snapshot blobs cannot be stored still ends, and reports it once: ${failure().name} (#4954)`, async () => {
		const { clone } = await sandbox.remoteWithClone();
		const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
		const store = await SqlSessionStore.open(database);
		cleanups.push(async () => {
			await store.close();
			await database.close();
		});
		const manager = await SessionManager.create(store, clone);
		const unavailable: WorktreeSnapshotUnavailable[] = [];
		const recorder = new SessionWorktreeSnapshotRecorder({
			sessionManager: manager,
			cwd: () => clone,
			settings: () => DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			declaresWrites: () => false,
			onUnavailable: (reason) => unavailable.push(reason),
		});
		const putBlobs = store.snapshotBlobs.putBlobs.bind(store.snapshotBlobs);
		store.snapshotBlobs.putBlobs = async () => {
			throw failure();
		};
		for (const name of ["a.txt", "b.txt"]) {
			sandbox.write(join(clone, name), name);
			await recorder.recordTurn(writing(join(clone, name)));
		}
		assert.equal(unavailable.length, 1, "reported once, not on every turn");
		const [reason] = unavailable;
		assert.equal(reason?.name, "WorkspaceSnapshotError");
		assert.equal(reason?.code, "blob-store-failed");
		assert.equal(reason?.fields.subject, "node-sqlite");
		assert.equal((reason?.cause as Error | undefined)?.name, failure().name);
		assert.equal(manager.getLatestWorktreeSnapshots().size, 0, "no snapshot recorded without its blobs");

		store.snapshotBlobs.putBlobs = putBlobs;
		sandbox.write(join(clone, "c.txt"), "c");
		await recorder.recordTurn(writing(join(clone, "c.txt")));
		assert.equal(manager.getLatestWorktreeSnapshots().size, 1, "the next turn records once storage works again");
	});
}

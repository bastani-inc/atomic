/**
 * The Git refs that keep a subagent's snapshot commits, when its session is kept in its parent's store, live as long as
 * the session that launched it: deleting that session deletes them, but not those of another session's subagents, of a
 * subagent open at that moment, or of a subagent session an earlier release wrote. Real Git checkout and SQLite session
 * store.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.js";
import {
	deleteSessionWithSnapshotRefs,
	SessionWorktreeSnapshotRecorder,
} from "../src/core/session-worktree-snapshots.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";

useTemporaryAgentDir();

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

async function project() {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return { clone, store };
}

/** A session of `store` that recorded a snapshot of `clone` after writing `file` there, as a turn records it. */
async function capturingSession(store: SqlSessionStore, clone: string, file: string, internal: boolean) {
	const manager = await SessionManager.create(store, clone, internal ? { internal: true } : undefined);
	await manager.appendMessage({ role: "user", content: `write ${file}`, timestamp: Date.now() });
	const recorder = new SessionWorktreeSnapshotRecorder({
		sessionManager: manager,
		cwd: () => clone,
		settings: () => DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		declaresWrites: () => false,
		isSubagent: () => internal,
		onUnavailable: (reason) => {
			throw new Error(`unexpected: ${reason.code}`);
		},
	});
	sandbox.write(join(clone, file), `${file}\n`);
	await recorder.recordTurn(
		fauxAssistantMessage([fauxToolCall("write", { path: join(clone, file), content: "" })], {
			stopReason: "toolUse",
		}),
	);
	return manager;
}

/** A session of `store` holding the record of a subagent whose own session is `childSessionId`, launched by `owner`. */
async function sessionRecording(store: SqlSessionStore, clone: string, owner: string | undefined, children: string[]) {
	const manager = await SessionManager.create(store, clone);
	await manager.appendMessage({ role: "user", content: "delegate", timestamp: Date.now() });
	for (const [index, childSessionId] of children.entries())
		await manager.appendCustomEntry("subagent-child", {
			version: 1,
			childId: `run-1:${index}`,
			owner: { kind: "session", sessionId: owner ?? manager.getSessionId() },
			childSessionId,
			state: "running",
		});
	return manager;
}

async function refsOf(clone: string, sessionId: string): Promise<string[]> {
	const listed = await sandbox.git(
		clone,
		"for-each-ref",
		"--format=%(refname)",
		`refs/atomic/snapshots/${sessionId}/`,
	);
	return listed.split("\n").filter((line) => line.length > 0);
}

test("deleting a session deletes the snapshot refs of the subagents it launched into its store", async () => {
	const { clone, store } = await project();
	const child = await capturingSession(store, clone, "child.txt", true);
	assert.equal((await refsOf(clone, child.getSessionId())).length, 1, "the subagent keeps a ref while it can go on");
	const parent = await sessionRecording(store, clone, undefined, [child.getSessionId()]);

	await deleteSessionWithSnapshotRefs(store, parent.getSessionId());
	assert.deepEqual(await refsOf(clone, child.getSessionId()), []);
});

test("deleting a session keeps the snapshot refs of another session's subagents whose records it copied", async () => {
	const { clone, store } = await project();
	const child = await capturingSession(store, clone, "child.txt", true);
	const parent = await sessionRecording(store, clone, undefined, [child.getSessionId()]);
	const fork = await sessionRecording(store, clone, parent.getSessionId(), [child.getSessionId()]);

	await deleteSessionWithSnapshotRefs(store, fork.getSessionId());
	assert.equal((await refsOf(clone, child.getSessionId())).length, 1);
});

test("deleting a session keeps the snapshot refs of a subagent open at that moment", async () => {
	const { clone, store } = await project();
	const child = await capturingSession(store, clone, "child.txt", true);
	cleanups.push(child.holdOpen());
	const parent = await sessionRecording(store, clone, undefined, [child.getSessionId()]);

	await deleteSessionWithSnapshotRefs(store, parent.getSessionId());
	assert.equal((await refsOf(clone, child.getSessionId())).length, 1);
});

test("deleting a session keeps the snapshot refs of a subagent session that is not its own internal one", async () => {
	const { clone, store } = await project();
	const listed = await capturingSession(store, clone, "listed.txt", false);
	const parent = await sessionRecording(store, clone, undefined, [listed.getSessionId()]);

	await deleteSessionWithSnapshotRefs(store, parent.getSessionId());
	assert.equal((await refsOf(clone, listed.getSessionId())).length, 1);
});

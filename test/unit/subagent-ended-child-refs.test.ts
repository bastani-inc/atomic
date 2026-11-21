/**
 * A subagent whose run ended for good gives up the Git refs that kept its snapshot commits once the record saying so
 * is saved, unless another process recorded a run of it in the owner's session since. Real Git checkout, and a SQLite
 * session store opened twice, as two processes open it.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SessionWorktreeSnapshotRecorder } from "../../packages/coding-agent/src/core/session-worktree-snapshots.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../../packages/coding-agent/src/core/worktree-snapshot/settings.js";
import {
	createSubagentChildRecordSink,
	releaseEndedChildRefs,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

useTemporaryAgentDir();

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

async function openStore(): Promise<SqlSessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

const CHILD_ID = "run-1:0";

function record(owner: SessionManager, childSessionId: string, state: "terminal" | "running") {
	return owner.appendCustomEntry("subagent-child", {
		version: 1,
		childId: CHILD_ID,
		runId: "run-1",
		index: 0,
		owner: { kind: "session", sessionId: owner.getSessionId() },
		childSessionId,
		state,
		...(state === "terminal" ? { terminalStatus: "ok" } : { pausedByUser: true }),
	});
}

/** An owner session and its subagent's session, whose run recorded a snapshot of a checkout and ended. */
async function endedSubagent() {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
	const store = await openStore();
	const owner = await SessionManager.create(store, clone);
	await owner.appendMessage({ role: "user", content: "delegate", timestamp: Date.now() });
	const child = await SessionManager.create(store, clone, { internal: true });
	await child.appendMessage({ role: "user", content: "write", timestamp: Date.now() });
	const recorder = new SessionWorktreeSnapshotRecorder({
		sessionManager: child,
		cwd: () => clone,
		settings: () => DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		declaresWrites: () => false,
		isSubagent: () => true,
		onUnavailable: (reason) => {
			throw new Error(`unexpected: ${reason.code}`);
		},
	});
	sandbox.write(join(clone, "child.txt"), "child\n");
	await recorder.recordTurn(
		fauxAssistantMessage([fauxToolCall("write", { path: join(clone, "child.txt"), content: "" })], {
			stopReason: "toolUse",
		}),
	);
	await record(owner, child.getSessionId(), "terminal");
	const sink = createSubagentChildRecordSink(
		{ appendEntry: async (type, data) => void (await owner.appendCustomEntry(type, data)) },
		{ sessionManager: owner },
	);
	const refs = async () =>
		(
			await sandbox.git(
				clone,
				"for-each-ref",
				"--format=%(refname)",
				`refs/atomic/snapshots/${child.getSessionId()}/`,
			)
		)
			.split("\n")
			.filter((line) => line.length > 0);
	assert.equal((await refs()).length, 1);
	return { owner, child, sink, refs };
}

test("a subagent whose run ended gives up its snapshot refs once the record of its end is saved", async () => {
	const { child, sink, refs } = await endedSubagent();
	await releaseEndedChildRefs(sink, CHILD_ID, child.getSessionId(), { status: "ok" }, false);
	assert.deepEqual(await refs(), []);
});

test("a subagent whose run ended keeps its snapshot refs when another process recorded a run of it since", async () => {
	const { owner, child, sink, refs } = await endedSubagent();
	// Another process opened the owner's session, ran the subagent again and paused it.
	const elsewhere = await SessionManager.open(await openStore(), owner.getSessionId());
	await record(elsewhere, child.getSessionId(), "running");

	await releaseEndedChildRefs(sink, CHILD_ID, child.getSessionId(), { status: "ok" }, false);
	assert.equal((await refs()).length, 1);
});

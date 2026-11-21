/**
 * Sessions of one process that capture the same checkout into the same blob table, as a session and its subagents do,
 * share the work: turns that end together from the same earlier snapshot share at most two captures, every session
 * records a snapshot taken after its own writes and from its own earlier snapshot, never another session's, and a turn
 * that ends while a capture runs gets the next one at once. Real Git checkout and SQLite session store.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.js";
import { exportSessions } from "../src/core/session-transfer.js";
import { SessionWorktreeSnapshotRecorder } from "../src/core/session-worktree-snapshots.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { resolveWorktreeSnapshotSettings } from "../src/core/worktree-snapshot/settings.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";

const captures = vi.hoisted(() => ({
	calls: 0,
	previous: [] as (string | undefined)[],
	/** Captures of these checkouts wait until `until` settles. */
	held: undefined as { readonly roots: ReadonlySet<string>; readonly until: Promise<void> } | undefined,
}));

vi.mock("../src/core/worktree-snapshot/capture.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/worktree-snapshot/capture.ts")>();
	return {
		...original,
		captureLocatedCheckout: async (...args: Parameters<typeof original.captureLocatedCheckout>) => {
			captures.calls++;
			captures.previous.push((args[1]?.previous as WorktreeSnapshot | undefined)?.id);
			if (captures.held?.roots.has(args[0].root)) await captures.held.until;
			return original.captureLocatedCheckout(...args);
		},
	};
});

useTemporaryAgentDir();

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
	captures.calls = 0;
	captures.previous = [];
	captures.held = undefined;
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

async function sessionStore(): Promise<SqlSessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

function recorderFor(manager: SessionManager, clone: string, subagent: boolean): SessionWorktreeSnapshotRecorder {
	return new SessionWorktreeSnapshotRecorder({
		sessionManager: manager,
		cwd: () => clone,
		settings: () => resolveWorktreeSnapshotSettings(undefined, "sdk", "snapshots"),
		declaresWrites: () => false,
		isSubagent: () => subagent,
		onUnavailable: (reason) => {
			throw new Error(`unexpected: ${reason.code}`);
		},
	});
}

async function checkoutWithSessions(count: number) {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
	const store = await sessionStore();
	const sessions = [];
	for (let index = 0; index < count; index++) {
		const manager = await SessionManager.create(store, clone, { internal: index > 0 });
		await manager.appendMessage({ role: "user", content: `work ${index}`, timestamp: Date.now() });
		const recorder = recorderFor(manager, clone, index > 0);
		sessions.push({ manager, recorder });
	}
	return { clone, store, sessions };
}

function wrote(path: string) {
	return fauxAssistantMessage([fauxToolCall("write", { path, content: "x" })], { stopReason: "toolUse" });
}

test("turns of sessions in one checkout that end together share at most two captures, each after its own writes", async () => {
	const { clone, sessions } = await checkoutWithSessions(4);
	sandbox.write(join(clone, "a.txt"), "first\n");
	await Promise.all(sessions.map(({ recorder }) => recorder.recordTurn(wrote(join(clone, "a.txt")))));

	assert.ok(captures.calls <= 2, `${captures.calls} captures for four turns`);
	const ids = sessions.map(({ manager }) => manager.getLatestWorktreeSnapshots().get(clone)?.id);
	assert.ok(ids[0]);
	assert.deepEqual(new Set(ids).size, 1, "every session records the same snapshot of the checkout");

	sandbox.write(join(clone, "a.txt"), "second\n");
	await sessions[1]!.recorder.recordTurn(wrote(join(clone, "a.txt")));
	const later = sessions[1]!.manager.getLatestWorktreeSnapshots().get(clone);
	assert.notEqual(later?.id, ids[0], "a turn after later writes gets a capture that holds them");
});

test("a session's first capture of a checkout records it from its commit, never from another session's snapshot", async () => {
	const { clone, sessions } = await checkoutWithSessions(2);
	const [parent, child] = sessions;
	sandbox.write(join(clone, "a.txt"), "parent\n");
	await parent!.recorder.recordTurn(wrote(join(clone, "a.txt")));
	assert.ok(parent!.manager.getLatestWorktreeSnapshots().get(clone));

	sandbox.write(join(clone, "b.txt"), "child\n");
	await child!.recorder.recordTurn(wrote(join(clone, "b.txt")));
	assert.equal(captures.previous.at(-1), undefined);
	const childSnapshot = child!.manager.getLatestWorktreeSnapshots().get(clone);
	assert.equal(childSnapshot?.delta.base, "head");
	assert.equal(childSnapshot?.chain.length, 1, "the child's snapshot holds no other session's history");
});

test("a session that recorded a snapshot of a checkout captures it from its own snapshot, not another session's", async () => {
	const { clone, sessions } = await checkoutWithSessions(2);
	const [parent, child] = sessions;
	sandbox.write(join(clone, "a.txt"), "parent\n");
	await parent!.recorder.recordTurn(wrote(join(clone, "a.txt")));
	const parentSnapshot = parent!.manager.getLatestWorktreeSnapshots().get(clone);
	assert.ok(parentSnapshot);
	sandbox.write(join(clone, "b.txt"), "child\n");
	await child!.recorder.recordTurn(wrote(join(clone, "b.txt")));

	sandbox.write(join(clone, "a.txt"), "parent again\n");
	await parent!.recorder.recordTurn(wrote(join(clone, "a.txt")));
	assert.equal(captures.previous.at(-1), parentSnapshot.id);
});

test("a turn that ends while a capture of its checkout runs from before its writes gets the next capture, started at once", async () => {
	const { clone, sessions } = await checkoutWithSessions(2);
	const [first, second] = sessions;
	const release = Promise.withResolvers<void>();
	captures.held = { roots: new Set([clone]), until: release.promise };
	sandbox.write(join(clone, "a.txt"), "first\n");
	const running = first!.recorder.recordTurn(wrote(join(clone, "a.txt")));
	let next: Promise<void> | undefined;
	try {
		await vi.waitFor(() => assert.equal(captures.calls, 1), { interval: 5 });
		sandbox.write(join(clone, "b.txt"), "second\n");
		next = second!.recorder.recordTurn(wrote(join(clone, "b.txt")));
		await vi.waitFor(() => assert.equal(captures.calls, 2, "the next capture starts while the first still runs"), {
			interval: 5,
		});
	} finally {
		release.resolve();
		await Promise.all([running, next]);
	}
	const snapshot = second!.manager.getLatestWorktreeSnapshots().get(clone);
	assert.ok(snapshot);
	assert.equal(await sandbox.git(clone, "cat-file", "-p", `${snapshot.tree}:b.txt`), "second");
});

test("a fresh session's exported history holds none of another session's earlier snapshots of the checkout", async () => {
	const { clone, store, sessions } = await checkoutWithSessions(2);
	const [parent, child] = sessions;
	// The session captures a file of its own, which is gone before its subagent ever works in the checkout.
	sandbox.write(join(clone, "scratch.txt"), "the session's own scratch notes\n");
	await parent!.recorder.recordTurn(wrote(join(clone, "scratch.txt")));
	const parentSnapshot = parent!.manager.getLatestWorktreeSnapshots().get(clone);
	assert.ok(parentSnapshot);
	rmSync(join(clone, "scratch.txt"));

	sandbox.write(join(clone, "child.txt"), "child\n");
	await child!.recorder.recordTurn(wrote(join(clone, "child.txt")));
	const childSnapshot = child!.manager.getLatestWorktreeSnapshots().get(clone);
	assert.ok(childSnapshot);

	await exportSessions(store, sandbox.path("export"));
	const exported = readFileSync(sandbox.path("export", `${child!.manager.getSessionId()}.jsonl`), "utf8");
	for (const { patch } of parentSnapshot.chain) if (patch !== null) assert.ok(!exported.includes(patch), patch);
	for (const { patch } of childSnapshot.chain)
		if (patch !== null) assert.ok(exported.includes(patch), "its own patch");
});

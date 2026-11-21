/**
 * Sessions of one process that capture the same checkout into the same blob table, as a session and its subagents do,
 * share the work: a burst of turns that end together costs at most two captures, every session records a snapshot
 * taken after its own writes, and a session's first capture starts from the newest snapshot of the checkout this
 * process took, so it reads only what changed. Real Git checkout and SQLite session store.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.js";
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

/** Structural cost: 33 real Git checkouts, each captured by its own session. */
const MANY_CHECKOUTS_TIMEOUT_MS = 120_000;

async function sessionStore(): Promise<SqlSessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

async function checkoutWithSessions(count: number, name = "repo", existing?: SqlSessionStore) {
	const { clone } = await sandbox.remoteWithClone(name, { "README.md": "hello\n" });
	const store = existing ?? (await sessionStore());
	const settings = resolveWorktreeSnapshotSettings(undefined, "sdk", "snapshots");
	const sessions = [];
	for (let index = 0; index < count; index++) {
		const manager = await SessionManager.create(store, clone, { internal: index > 0 });
		await manager.appendMessage({ role: "user", content: `work ${index}`, timestamp: Date.now() });
		const recorder = new SessionWorktreeSnapshotRecorder({
			sessionManager: manager,
			cwd: () => clone,
			settings: () => settings,
			declaresWrites: () => false,
			isSubagent: () => index > 0,
			onUnavailable: (reason) => {
				throw new Error(`unexpected: ${reason.code}`);
			},
		});
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

test("a session's first capture of a checkout starts from the newest snapshot of it this process took", async () => {
	const { clone, sessions } = await checkoutWithSessions(2);
	const [parent, child] = sessions;
	sandbox.write(join(clone, "a.txt"), "parent\n");
	await parent!.recorder.recordTurn(wrote(join(clone, "a.txt")));
	const parentSnapshot = parent!.manager.getLatestWorktreeSnapshots().get(clone);
	assert.ok(parentSnapshot);

	sandbox.write(join(clone, "b.txt"), "child\n");
	await child!.recorder.recordTurn(wrote(join(clone, "b.txt")));
	assert.equal(captures.previous.at(-1), parentSnapshot.id, "the child's capture starts from the parent's snapshot");
	const childSnapshot = child!.manager.getLatestWorktreeSnapshots().get(clone);
	assert.ok(childSnapshot && childSnapshot.id !== parentSnapshot.id);
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

test(
	"a checkout captured while as many others are being captured still gives its snapshot to the next session's first capture",
	async () => {
		const store = await sessionStore();
		const busy = [];
		for (let index = 0; index < 32; index++) busy.push(await checkoutWithSessions(1, `busy-${index}`, store));
		const { clone, sessions } = await checkoutWithSessions(2, "last", store);
		const release = Promise.withResolvers<void>();
		captures.held = { roots: new Set(busy.map(({ clone }) => clone)), until: release.promise };
		const running = busy.map(({ clone, sessions }) => {
			sandbox.write(join(clone, "a.txt"), "busy\n");
			return sessions[0]!.recorder.recordTurn(wrote(join(clone, "a.txt")));
		});
		try {
			await vi.waitFor(() => assert.equal(captures.calls, 32), { timeout: MANY_CHECKOUTS_TIMEOUT_MS, interval: 10 });
			const [first, next] = sessions;
			sandbox.write(join(clone, "a.txt"), "first\n");
			await first!.recorder.recordTurn(wrote(join(clone, "a.txt")));
			const firstSnapshot = first!.manager.getLatestWorktreeSnapshots().get(clone);
			assert.ok(firstSnapshot);
			sandbox.write(join(clone, "b.txt"), "next\n");
			await next!.recorder.recordTurn(wrote(join(clone, "b.txt")));
			assert.equal(captures.previous.at(-1), firstSnapshot.id);
		} finally {
			release.resolve();
			await Promise.all(running);
		}
	},
	MANY_CHECKOUTS_TIMEOUT_MS,
);

/**
 * Sessions of one process that capture the same checkout into the same blob table, as a session and its subagents do,
 * share the work: turns that end together from the same earlier snapshot share at most two captures, every session
 * records a snapshot taken after its own writes and from its own earlier snapshot, never another session's, and the
 * turns that end while a capture runs share the next one, which starts when it ends. Real Git checkout and SQLite
 * session store.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GIT_PROCESS_BUDGET_MS, GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.js";
import { exportSessions } from "../src/core/session-transfer.js";
import { QUEUED_CAPTURE_MIN_WAIT_MS, SessionWorktreeSnapshotRecorder } from "../src/core/session-worktree-snapshots.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { resolveWorktreeSnapshotSettings } from "../src/core/worktree-snapshot/settings.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";

/**
 * Budget for a synchronization point that waits on real Git work (up to one full snapshot capture plus a follow-up
 * checkout lookup, roughly fifteen Git processes on a loaded runner).
 */
const CAPTURE_WAIT_TIMEOUT_MS = 50 * GIT_PROCESS_BUDGET_MS;
const CAPTURE_WAIT = { timeout: CAPTURE_WAIT_TIMEOUT_MS, interval: 5 } as const;
/** Upper multiplier matching the queued-capture wait formula (`4 * lastCaptureMs`) when advancing fake timers. */
const QUEUED_CAPTURE_WAIT_MULTIPLIER = 4;

const captures = vi.hoisted(() => ({
	/** Turns that reached their capture: by then each has joined, queued or started one. */
	entered: 0,
	calls: 0,
	inFlight: 0,
	maxInFlight: 0,
	previous: [] as (string | undefined)[],
	/** Longest elapsed duration of any completed capture in this worker, bounding the module-level `lastCaptureMs`. */
	maxElapsedMs: 0,
	/** Captures of these checkouts wait until `until` settles. */
	held: undefined as { readonly roots: ReadonlySet<string>; readonly until: Promise<void> } | undefined,
	/** Optional gate intercepting the next `recordWorktreeCapture` entry before `sharedCheckoutCapture` runs. */
	interceptEnter: undefined as ((proceed: () => Promise<void>) => Promise<void>) | undefined,
	/** Optional observer receiving the exact promise returned by `captureLocatedCheckout`. */
	onCapturePromise: undefined as ((promise: Promise<unknown>) => void) | undefined,
}));

vi.mock("../src/core/worktree-snapshot/capture.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/worktree-snapshot/capture.ts")>();
	return {
		...original,
		recordWorktreeCapture: (...args: Parameters<typeof original.recordWorktreeCapture>) => {
			captures.entered++;
			const run = async () => {
				const started = performance.now();
				try {
					return await original.recordWorktreeCapture(...args);
				} finally {
					captures.maxElapsedMs = Math.max(captures.maxElapsedMs, performance.now() - started);
				}
			};
			if (captures.interceptEnter !== undefined) {
				const intercept = captures.interceptEnter;
				captures.interceptEnter = undefined;
				return intercept(run);
			}
			return run();
		},
		captureLocatedCheckout: (...args: Parameters<typeof original.captureLocatedCheckout>) => {
			const promise = (async () => {
				captures.calls++;
				captures.inFlight++;
				captures.maxInFlight = Math.max(captures.maxInFlight, captures.inFlight);
				captures.previous.push((args[1]?.previous as WorktreeSnapshot | undefined)?.id);
				try {
					if (captures.held?.roots.has(args[0].root)) await captures.held.until;
					return await original.captureLocatedCheckout(...args);
				} finally {
					captures.inFlight--;
				}
			})();
			captures.onCapturePromise?.(promise);
			return promise;
		},
	};
});

useTemporaryAgentDir();

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
	captures.entered = 0;
	captures.calls = 0;
	captures.inFlight = 0;
	captures.maxInFlight = 0;
	captures.previous = [];
	captures.held = undefined;
	captures.interceptEnter = undefined;
	captures.onCapturePromise = undefined;
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

test("turns that end while a capture of their checkout runs from before their writes share the next capture, which starts when it ends", async () => {
	// Captures of one checkout that run side by side slow each other down, on Windows several times over: the turns that
	// end while one runs wait for it and then share one capture.
	const { clone, sessions } = await checkoutWithSessions(3);
	const [first, second, third] = sessions;
	const release = Promise.withResolvers<void>();
	captures.held = { roots: new Set([clone]), until: release.promise };
	sandbox.write(join(clone, "a.txt"), "first\n");
	const running = first!.recorder.recordTurn(wrote(join(clone, "a.txt")));
	let next: Promise<unknown> | undefined;
	try {
		await vi.waitFor(() => assert.equal(captures.calls, 1), CAPTURE_WAIT);
		sandbox.write(join(clone, "b.txt"), "second\n");
		sandbox.write(join(clone, "c.txt"), "third\n");
		next = Promise.all([
			second!.recorder.recordTurn(wrote(join(clone, "b.txt"))),
			third!.recorder.recordTurn(wrote(join(clone, "c.txt"))),
		]);
		await vi.waitFor(() => assert.equal(captures.entered, 3), CAPTURE_WAIT);
		assert.equal(captures.calls, 1, "no capture starts beside the running one");
	} finally {
		release.resolve();
		await Promise.all([running, next]);
	}
	assert.equal(captures.calls, 2, "the turns that ended meanwhile share one capture");
	for (const [session, path, content] of [
		[second, "b.txt", "second"],
		[third, "c.txt", "third"],
	] as const) {
		const snapshot = session!.manager.getLatestWorktreeSnapshots().get(clone);
		assert.ok(snapshot);
		assert.equal(await sandbox.git(clone, "cat-file", "-p", `${snapshot.tree}:${path}`), content);
	}
	// A turn after those captures gets one of its own that holds its writes.
	sandbox.write(join(clone, "d.txt"), "fourth\n");
	await first!.recorder.recordTurn(wrote(join(clone, "d.txt")));
	const later = first!.manager.getLatestWorktreeSnapshots().get(clone);
	assert.ok(later);
	assert.equal(await sandbox.git(clone, "cat-file", "-p", `${later.tree}:d.txt`), "fourth");
});

test("a turn that ends while the capture queued for earlier turns runs gets a capture after it, which holds its writes", async () => {
	const { clone, sessions } = await checkoutWithSessions(3);
	const [first, second, third] = sessions;
	const releaseFirst = Promise.withResolvers<void>();
	const releaseSecond = Promise.withResolvers<void>();
	captures.held = { roots: new Set([clone]), until: releaseFirst.promise };
	sandbox.write(join(clone, "a.txt"), "first\n");
	const turns: Promise<void>[] = [first!.recorder.recordTurn(wrote(join(clone, "a.txt")))];
	try {
		await vi.waitFor(() => assert.equal(captures.calls, 1), CAPTURE_WAIT);
		sandbox.write(join(clone, "b.txt"), "second\n");
		turns.push(second!.recorder.recordTurn(wrote(join(clone, "b.txt"))));
		await vi.waitFor(() => assert.equal(captures.entered, 2), CAPTURE_WAIT);
		// The capture queued for the second turn starts once the first ends, and runs until released.
		captures.held = { roots: new Set([clone]), until: releaseSecond.promise };
		releaseFirst.resolve();
		await vi.waitFor(() => assert.equal(captures.calls, 2), CAPTURE_WAIT);
		sandbox.write(join(clone, "c.txt"), "third\n");
		turns.push(third!.recorder.recordTurn(wrote(join(clone, "c.txt"))));
		await vi.waitFor(() => assert.equal(captures.entered, 3), CAPTURE_WAIT);
	} finally {
		releaseFirst.resolve();
		releaseSecond.resolve();
		await Promise.all(turns);
	}
	assert.equal(captures.calls, 3);
	const snapshot = third!.manager.getLatestWorktreeSnapshots().get(clone);
	assert.ok(snapshot);
	assert.equal(await sandbox.git(clone, "cat-file", "-p", `${snapshot.tree}:c.txt`), "third");
});

test("a turn that commits and ends while a capture runs records a snapshot of the commit it made", async () => {
	const { clone, sessions } = await checkoutWithSessions(3);
	const [first, second, third] = sessions;
	const release = Promise.withResolvers<void>();
	captures.held = { roots: new Set([clone]), until: release.promise };
	sandbox.write(join(clone, "a.txt"), "first\n");
	const turns: Promise<void>[] = [first!.recorder.recordTurn(wrote(join(clone, "a.txt")))];
	let committed = "";
	try {
		await vi.waitFor(() => assert.equal(captures.calls, 1), CAPTURE_WAIT);
		// One turn ends and queues a capture, which it looked the checkout up for before the next turn's commit.
		sandbox.write(join(clone, "b.txt"), "second\n");
		turns.push(second!.recorder.recordTurn(wrote(join(clone, "b.txt"))));
		await vi.waitFor(() => assert.equal(captures.entered, 2), CAPTURE_WAIT);
		// The next commits its work, as `git commit` through bash does, and ends while the first capture still runs.
		sandbox.write(join(clone, "c.txt"), "third\n");
		committed = (await sandbox.commitAll(clone, "third's work")).trim();
		turns.push(third!.recorder.recordTurn(wrote(join(clone, "c.txt"))));
		await vi.waitFor(() => assert.equal(captures.entered, 3), CAPTURE_WAIT);
	} finally {
		release.resolve();
		await Promise.all(turns);
	}
	for (const session of [second, third]) {
		const snapshot = session!.manager.getLatestWorktreeSnapshots().get(clone);
		assert.ok(snapshot);
		assert.equal(snapshot.head, committed, "the snapshot names the commit, so a restore keeps it");
	}
});

test("a capture that runs far longer than captures do no longer holds the turns queued behind it", async () => {
	const { clone, sessions } = await checkoutWithSessions(2);
	const [first, second] = sessions;
	const release = Promise.withResolvers<void>();
	captures.held = { roots: new Set([clone]), until: release.promise };
	sandbox.write(join(clone, "a.txt"), "first\n");
	const startedFirstMs = performance.now();
	const stuck = first!.recorder.recordTurn(wrote(join(clone, "a.txt")));
	let queued: Promise<void> | undefined;
	try {
		await vi.waitFor(() => assert.equal(captures.calls, 1), CAPTURE_WAIT);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
		sandbox.write(join(clone, "b.txt"), "second\n");
		// Only the first turn's capture is held: the one that starts once the wait is over runs.
		captures.held = { roots: new Set(), until: release.promise };
		queued = second!.recorder.recordTurn(wrote(join(clone, "b.txt")));
		await vi.waitFor(() => assert.equal(captures.entered, 2), CAPTURE_WAIT);
		assert.equal(captures.calls, 1, "the turn waits for the running capture");
		// However short the captures before were, it waits that long at least. A capture starts as its timer fires.
		const elapsedSinceFirstMs = performance.now() - startedFirstMs;
		const halfwayAdvanceMs = Math.max(0, Math.floor(QUEUED_CAPTURE_MIN_WAIT_MS / 2 - elapsedSinceFirstMs));
		vi.advanceTimersByTime(halfwayAdvanceMs);
		assert.equal(captures.calls, 1, "it still waits halfway through the wait");
		const pastWaitMs = Math.max(
			QUEUED_CAPTURE_MIN_WAIT_MS,
			Math.ceil(QUEUED_CAPTURE_WAIT_MULTIPLIER * captures.maxElapsedMs) + 1,
		);
		vi.advanceTimersByTime(pastWaitMs);
		await vi.waitFor(
			() => assert.equal(captures.calls, 2, "past the wait, the queued capture starts beside it"),
			CAPTURE_WAIT,
		);
		await queued;
		const snapshot = second!.manager.getLatestWorktreeSnapshots().get(clone);
		assert.ok(snapshot);
		assert.equal(await sandbox.git(clone, "cat-file", "-p", `${snapshot.tree}:b.txt`), "second");
	} finally {
		vi.useRealTimers();
		release.resolve();
		await Promise.all([stuck, queued]);
	}
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

test("handing off to a queued capture is atomic: a turn entering in the settlement microtask never observes an idle gap or starts a concurrent capture", async () => {
	const { clone, sessions } = await checkoutWithSessions(3);
	const [first, second, third] = sessions;
	const releaseFirst = Promise.withResolvers<void>();
	const releaseSecond = Promise.withResolvers<void>();
	let firstCapturePromise: Promise<unknown> | undefined;
	captures.onCapturePromise = (promise) => {
		firstCapturePromise ??= promise;
	};
	captures.held = { roots: new Set([clone]), until: releaseFirst.promise };
	sandbox.write(join(clone, "a.txt"), "first\n");
	const firstTurn = first!.recorder.recordTurn(wrote(join(clone, "a.txt")));
	let secondTurn: Promise<void> | undefined;
	let thirdTurn: Promise<void> | undefined;
	try {
		await vi.waitFor(() => assert.equal(captures.calls, 1), CAPTURE_WAIT);
		assert.ok(firstCapturePromise, "captured the running capture's promise");

		// Inject `third` directly on `firstCapturePromise`'s reaction queue *before* `second` queues behind `first`,
		// so `third` enters `sharedCheckoutCapture` in the exact microtask right after `first` settles and before any
		// separately-chained queued-capture callback would run.
		const thirdSettled = Promise.withResolvers<void>();
		captures.interceptEnter = (proceed) => {
			firstCapturePromise!.then(() => {
				proceed().then(thirdSettled.resolve, thirdSettled.reject);
			});
			return thirdSettled.promise;
		};
		sandbox.write(join(clone, "c.txt"), "third\n");
		thirdTurn = third!.recorder.recordTurn(wrote(join(clone, "c.txt")));
		await vi.waitFor(() => assert.equal(captures.entered, 2), CAPTURE_WAIT);

		// Now `second` enters and queues Capture 2 behind `first`.
		sandbox.write(join(clone, "b.txt"), "second\n");
		secondTurn = second!.recorder.recordTurn(wrote(join(clone, "b.txt")));
		await vi.waitFor(() => assert.equal(captures.entered, 3), CAPTURE_WAIT);
		assert.equal(captures.calls, 1, "no capture starts beside the running one");

		// Release `first` while holding any subsequent capture so concurrent starts overlap visibly.
		captures.held = { roots: new Set([clone]), until: releaseSecond.promise };
		releaseFirst.resolve();
		await vi.waitFor(() => assert.equal(captures.calls, 2), CAPTURE_WAIT);
		// Allow any duplicate capture spawned in a non-atomic hand-off gap to reach `captureLocatedCheckout`.
		await new Promise((resolve) => setTimeout(resolve, 250));
		assert.equal(captures.maxInFlight, 1, "at most one capture runs at a time across the hand-off");
		assert.equal(
			captures.calls,
			2,
			"the interleaved turn joins the promoted queued capture instead of starting another",
		);
	} finally {
		releaseFirst.resolve();
		releaseSecond.resolve();
		await Promise.all([firstTurn, secondTurn, thirdTurn]);
	}
	assert.equal(captures.maxInFlight, 1);
	assert.equal(captures.calls, 2);
	for (const [session, path, content] of [
		[second, "b.txt", "second"],
		[third, "c.txt", "third"],
	] as const) {
		const snapshot = session!.manager.getLatestWorktreeSnapshots().get(clone);
		assert.ok(snapshot);
		assert.equal(await sandbox.git(clone, "cat-file", "-p", `${snapshot.tree}:${path}`), content);
	}
});

test("a superseded stuck capture that finishes later does not inflate the wait budget for subsequent queued captures", async () => {
	const { clone, sessions } = await checkoutWithSessions(5);
	const [warmup, stuckTurn, queuedAfterStuck, laterStuckTurn, laterQueuedTurn] = sessions;
	const releaseStuck = Promise.withResolvers<void>();
	const releaseLaterStuck = Promise.withResolvers<void>();
	let stuckPromise: Promise<void> | undefined;
	let queuedPromise: Promise<void> | undefined;
	let laterStuckPromise: Promise<void> | undefined;
	let laterQueuedPromise: Promise<void> | undefined;
	try {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"], shouldAdvanceTime: true });
		// Establish a short baseline `lastCaptureMs` so the first stuck wait is bounded by a known duration.
		sandbox.write(join(clone, "warmup.txt"), "warmup\n");
		const warmupStart = performance.now();
		await warmup!.recorder.recordTurn(wrote(join(clone, "warmup.txt")));
		const warmupMs = performance.now() - warmupStart;
		const callsAfterWarmup = captures.calls;

		// Start Capture 1 (stuck) and queue Capture 2 behind it.
		captures.held = { roots: new Set([clone]), until: releaseStuck.promise };
		sandbox.write(join(clone, "a.txt"), "stuck\n");
		stuckPromise = stuckTurn!.recorder.recordTurn(wrote(join(clone, "a.txt")));
		await vi.waitFor(() => assert.equal(captures.calls, callsAfterWarmup + 1), CAPTURE_WAIT);

		captures.held = { roots: new Set(), until: releaseStuck.promise };
		sandbox.write(join(clone, "b.txt"), "second\n");
		const enteredBeforeSecond = captures.entered;
		queuedPromise = queuedAfterStuck!.recorder.recordTurn(wrote(join(clone, "b.txt")));
		await vi.waitFor(() => assert.equal(captures.entered, enteredBeforeSecond + 1), CAPTURE_WAIT);

		// Wait expires: Capture 2 starts, superseding Capture 1, and finishes quickly.
		vi.advanceTimersByTime(
			Math.max(QUEUED_CAPTURE_MIN_WAIT_MS, Math.ceil(QUEUED_CAPTURE_WAIT_MULTIPLIER * warmupMs) + 1),
		);
		const capture2Start = performance.now();
		await vi.waitFor(() => assert.equal(captures.calls, callsAfterWarmup + 2), CAPTURE_WAIT);
		await queuedPromise;
		const capture2Ms = performance.now() - capture2Start;

		// Advance clock far past `QUEUED_CAPTURE_MIN_WAIT_MS` before the superseded stuck capture finally finishes.
		vi.advanceTimersByTime(4 * QUEUED_CAPTURE_MIN_WAIT_MS);
		releaseStuck.resolve();
		await stuckPromise;

		// A subsequent queued capture must still wait only the normal budget (not 4x the superseded stuck duration).
		captures.held = { roots: new Set([clone]), until: releaseLaterStuck.promise };
		sandbox.write(join(clone, "c.txt"), "later-stuck\n");
		laterStuckPromise = laterStuckTurn!.recorder.recordTurn(wrote(join(clone, "c.txt")));
		await vi.waitFor(() => assert.equal(captures.calls, callsAfterWarmup + 3), CAPTURE_WAIT);

		captures.held = { roots: new Set(), until: releaseLaterStuck.promise };
		sandbox.write(join(clone, "d.txt"), "later-queued\n");
		const enteredBeforeLaterQueued = captures.entered;
		laterQueuedPromise = laterQueuedTurn!.recorder.recordTurn(wrote(join(clone, "d.txt")));
		await vi.waitFor(() => assert.equal(captures.entered, enteredBeforeLaterQueued + 1), CAPTURE_WAIT);

		vi.advanceTimersByTime(
			Math.max(QUEUED_CAPTURE_MIN_WAIT_MS, Math.ceil(QUEUED_CAPTURE_WAIT_MULTIPLIER * capture2Ms) + 1),
		);
		await vi.waitFor(
			() =>
				assert.equal(
					captures.calls,
					callsAfterWarmup + 4,
					"a superseded stuck capture must not inflate subsequent queued capture waits",
				),
			CAPTURE_WAIT,
		);
		await laterQueuedPromise;
	} finally {
		vi.useRealTimers();
		releaseStuck.resolve();
		releaseLaterStuck.resolve();
		await Promise.all([stuckPromise, queuedPromise, laterStuckPromise, laterQueuedPromise]);
	}
});

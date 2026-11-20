import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import {
	ENDED_QUEUE_LOCK_WAIT_MS,
	type EndedChildQueueStore,
	type EndedQueueEntry,
	openLocalEndedChildQueueStore,
	openSqlEndedChildQueueStore,
} from "../../packages/intercom/broker/sql-ended-child-queue-store.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

/**
 * #5999 durable wake queue: the store that keeps messages for subagents that ended across broker restarts, opened the
 * way a broker opens it: the local file, or a shared database under a prefix.
 */

const directories: string[] = [];
const opened: EndedChildQueueStore[] = [];
afterEach(async () => {
	for (const store of opened.splice(0)) await store.close().catch(() => {});
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

function directory(): string {
	const made = makeTempDirectory("ended-child-queue-store-");
	directories.push(made);
	return made;
}

async function open(path: string, holder: string, retire = false): Promise<EndedChildQueueStore> {
	const store = await openLocalEndedChildQueueStore(path, holder, retire);
	opened.push(store);
	return store;
}

function entry(messageId: string, child = "subagent-worker-1", text = "hello"): EndedQueueEntry {
	return {
		messageId,
		ownerSessionId: "owner-1",
		ownerHost: "owner-host",
		childKey: child,
		child: {
			childName: child,
			group: "default",
			aliases: [],
			childId: "run:0",
			outcome: "completed",
			messages: "wake",
		},
		sender: { info: { id: "sender-1", name: "sender" }, registrationReturnAddress: "sender-host" },
		request: {
			type: "send",
			to: child,
			wakeEndedRecipient: true,
			message: { id: messageId, timestamp: 1, content: { text } },
		},
		bytes: text.length,
		queuedAt: 1_000,
	};
}

test("messages a broker kept come back to the next one, in the order they were queued, with their wake and wake bounds", async () => {
	const path = join(directory(), "ended-child-queue.sqlite");
	const first = await open(path, "broker-1");
	// Written out of id order: the order they were queued in is what comes back.
	for (const id of ["m3", "m1", "m2"]) assert.equal(await first.add(entry(id)), "added");
	await first.setWake(
		{ ownerSessionId: "owner-1", ownerHost: "owner-host", childKey: "subagent-worker-1" },
		{
			id: "wake-1",
			depth: 2,
			acceptedAt: 5_000,
		},
	);
	// A departure key holds a NUL; it is kept all the same.
	const wokenAt = Date.now();
	await first.recordBudget({ childKey: "owner-1\0subagent-worker-1", kind: "wake", at: wokenAt, depth: 2 });
	const id = first.id;
	await first.close();

	const next = await open(path, "broker-2");
	assert.equal(next.id, id, "the same store, the same identity");
	const { rows, budget } = await next.load();
	assert.deepEqual(
		rows.map((row) => [row.messageId, row.request.message, row.wake]),
		[
			["m3", { id: "m3", timestamp: 1, content: { text: "hello" } }, { id: "wake-1", depth: 2, acceptedAt: 5_000 }],
			["m1", { id: "m1", timestamp: 1, content: { text: "hello" } }, { id: "wake-1", depth: 2, acceptedAt: 5_000 }],
			["m2", { id: "m2", timestamp: 1, content: { text: "hello" } }, { id: "wake-1", depth: 2, acceptedAt: 5_000 }],
		],
	);
	assert.deepEqual(budget, [{ childKey: "owner-1\0subagent-worker-1", kind: "wake", at: wokenAt, depth: 2 }]);
});

test("a message kept once is kept once: the same id again is a duplicate", async () => {
	const store = await open(join(directory(), "ended-child-queue.sqlite"), "broker-1");
	assert.equal(await store.add(entry("m1")), "added");
	assert.equal(await store.add(entry("m1")), "duplicate");
	assert.equal((await store.load()).rows.length, 1);
});

test("a broker that took the rows over fences out the one before it: its later writes change nothing", async () => {
	const path = join(directory(), "ended-child-queue.sqlite");
	const hung = await open(path, "broker-1");
	await hung.add(entry("m1"));
	await hung.add(entry("m2"));
	const next = await open(path, "broker-2");
	assert.equal((await next.load()).rows.length, 2);
	// The take-over is the first of its writes; one more of them proves it committed.
	await next.fail("m2", "proved", 1);
	// The earlier instance comes back to life and deletes what it thinks it still holds.
	await hung.remove(["m1"]);
	assert.deepEqual(
		(await next.load()).rows.map((row) => row.messageId),
		["m1", "m2"],
		"nothing it no longer holds is deleted",
	);
	await next.remove(["m1"]);
	assert.deepEqual(
		(await next.load()).rows.map((row) => row.messageId),
		["m2"],
	);
});

test("a failure for a sender that is away is kept, with its reason, until it is told", async () => {
	const path = join(directory(), "ended-child-queue.sqlite");
	const store = await open(path, "broker-1");
	await store.add(entry("m1"));
	await store.fail("m1", "its launching session ended", 7_000);
	await store.close();
	const next = await open(path, "broker-2");
	assert.deepEqual(
		(await next.load()).rows.map((row) => [row.messageId, row.failed]),
		[["m1", { reason: "its launching session ended", at: 7_000 }]],
	);
});

test("a store retired by a broker that kept the queue in memory delivers nothing it kept before, under a new identity", async () => {
	const path = join(directory(), "ended-child-queue.sqlite");
	const earlier = await open(path, "broker-1");
	await earlier.add(entry("m1"));
	const id = earlier.id;
	await earlier.close();
	// A broker in between told its sessions m1 was lost: the next one opens the store retired.
	const next = await open(path, "broker-3", true);
	assert.notEqual(next.id, id, "senders that kept m1 under the old identity learn it is gone");
	assert.deepEqual((await next.load()).rows, []);
	await next.add(entry("m2"));
	await next.close();
	const after = await open(path, "broker-4");
	assert.equal(after.id, next.id);
	assert.deepEqual(
		(await after.load()).rows.map((row) => row.messageId),
		["m2"],
	);
});

test("one write that fails fails only its own caller, not the others committed with it", async () => {
	const store = await open(join(directory(), "ended-child-queue.sqlite"), "broker-1");
	const bad = { ...entry("bad"), request: { cyclic: undefined as unknown } } as EndedQueueEntry;
	(bad.request as { cyclic: unknown }).cyclic = bad.request;
	const results = await Promise.allSettled([store.add(entry("m1")), store.add(bad), store.add(entry("m2"))]);
	assert.deepEqual(
		results.map((result) => result.status),
		["fulfilled", "rejected", "fulfilled"],
	);
	assert.deepEqual(
		(await store.load()).rows.map((row) => row.messageId),
		["m1", "m2"],
	);
});

test("in a shared database each broker home keeps its own rows and identity, under the prefix", async () => {
	const database = await openNodeSqliteDatabase(join(directory(), "shared.sqlite"));
	try {
		const a = await openSqlEndedChildQueueStore({ database, prefix: "p_" }, { home: "host-a", holder: "broker-a" });
		const b = await openSqlEndedChildQueueStore({ database, prefix: "p_" }, { home: "host-b", holder: "broker-b" });
		await a.add(entry("a1"));
		await b.add(entry("b1"));
		assert.notEqual(a.id, b.id);
		assert.deepEqual(
			(await a.load()).rows.map((row) => row.messageId),
			["a1"],
		);
		assert.deepEqual(
			(await b.load()).rows.map((row) => row.messageId),
			["b1"],
		);
		const tables = await database.all<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'p_intercom_ended_child_%' ORDER BY name",
		);
		assert.deepEqual(
			tables.map((table) => table.name),
			[
				"p_intercom_ended_child_bodies",
				"p_intercom_ended_child_meta",
				"p_intercom_ended_child_queue",
				"p_intercom_ended_child_wakes",
			],
		);
		await a.close();
		await b.close();
	} finally {
		await database.close();
	}
});

test("under another process's write lock, a message's write fails within one lock wait, and those behind it at once", async () => {
	const path = join(directory(), "ended-child-queue.sqlite");
	const database = await openNodeSqliteDatabase(path);
	const store = await openSqlEndedChildQueueStore(
		{ database, prefix: "" },
		{ home: "local", holder: "broker-1", lockWaitMs: 300 },
	);
	const { DatabaseSync } = await import("node:sqlite");
	const other = new DatabaseSync(path);
	other.exec("BEGIN IMMEDIATE");
	try {
		const started = performance.now();
		const first = store.add(entry("m1")).then(
			() => "kept",
			() => performance.now() - started,
		);
		// Asked for while the first waits for the lock: behind it, in the next batch.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const behind = store.add(entry("m2")).then(
			() => "kept",
			() => performance.now() - started,
		);
		const [firstFailedAt, behindFailedAt] = await Promise.all([first, behind]);
		assert.equal(typeof firstFailedAt, "number", "the first fails: the lock is not free");
		assert.equal(typeof behindFailedAt, "number");
		// Measured from the first one's failure, not from the start: on a loaded host the first one's wait itself runs late.
		assert.ok(
			(behindFailedAt as number) - (firstFailedAt as number) < 300,
			`the one behind failed ${(behindFailedAt as number) - (firstFailedAt as number)} ms after the first, not a second lock wait later`,
		);
	} finally {
		other.exec("ROLLBACK");
		other.close();
	}
	// The lock is free again: once the breaker's wait is over, writes go through (twice its wait: a timer may fire early
	// by the event loop's own lag).
	await new Promise((resolve) => setTimeout(resolve, 2 * 300));
	assert.equal(await store.add(entry("m3")), "added");
	await store.close();
	await database.close();
});

test("a full queue is read a page at a time, and the event loop runs between pages", async () => {
	const path = join(directory(), "ended-child-queue.sqlite");
	const writer = await open(path, "broker-1");
	const big = "x".repeat(400 * 1024);
	for (let index = 0; index < 8; index++)
		await writer.add({ ...entry(`m${index}`, "subagent-worker-1", big), bytes: big.length });
	await writer.close();
	const next = await open(path, "broker-2");
	const pages: string[][] = [];
	let ticks = 0;
	const ticker = setInterval(() => {
		ticks += 1;
	}, 0);
	const turns: number[] = [];
	try {
		const { rows } = await next.load((page) => {
			pages.push(page.map((row) => row.messageId));
			turns.push(ticks);
		});
		assert.deepEqual(
			rows.map((row) => row.messageId),
			["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"],
		);
	} finally {
		clearInterval(ticker);
	}
	assert.deepEqual(pages.flat(), ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"], "in order, each once");
	assert.ok(
		pages.every((page) => page.length <= 2),
		`at most about 1 MiB a page: ${JSON.stringify(pages)}`,
	);
	assert.ok(new Set(turns).size > 1, "timers ran between pages");
	assert.deepEqual(await next.targets(), ["subagent-worker-1"]);
});

/** The bytes the store's file and its write-ahead log take on disk now. */
function onDisk(path: string): number {
	return [path, `${path}-wal`].reduce((total, file) => total + (existsSync(file) ? statSync(file).size : 0), 0);
}

async function fillAndDrain(store: EndedChildQueueStore, count: number): Promise<void> {
	const big = "x".repeat(1024 * 1024 - 64);
	const ids = Array.from({ length: count }, (_, index) => `m${index}`);
	for (const id of ids) await store.add({ ...entry(id, "subagent-worker-1", big), bytes: big.length });
	await store.remove(ids);
}

/** The file's auto-vacuum mode: 0 none, 2 incremental. */
async function autoVacuum(path: string): Promise<number> {
	const { DatabaseSync } = await import("node:sqlite");
	const check = new DatabaseSync(path, { readOnly: true });
	try {
		return (check.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum;
	} finally {
		check.close();
	}
}

test("the store gives its disk space back once its queue drains", async () => {
	const path = join(directory(), "ended-child-queue.sqlite");
	const store = await open(path, "broker-1");
	assert.equal(await autoVacuum(path), 2, "a new file can give space back");
	await fillAndDrain(store, 24);
	await vi.waitFor(() => assert.ok(onDisk(path) < 4 * 1024 * 1024, `still ${onDisk(path)} bytes`), {
		timeout: 20_000,
		interval: 50,
	});
	// It is still the same store, and keeps working.
	assert.equal(await store.add(entry("after")), "added");
	assert.deepEqual(
		(await store.load()).rows.map((row) => row.messageId),
		["after"],
	);
});

test("a store from before that cannot give space back is converted once its queue is empty, and then does", async () => {
	const path = join(directory(), "ended-child-queue.sqlite");
	const first = await open(path, "broker-1");
	await first.close();
	// As a broker of the earlier release left it: no auto-vacuum.
	const { DatabaseSync } = await import("node:sqlite");
	const earlier = new DatabaseSync(path);
	earlier.exec("PRAGMA auto_vacuum = NONE; VACUUM;");
	earlier.close();
	const store = await open(path, "broker-2");
	await fillAndDrain(store, 24);
	await vi.waitFor(() => assert.ok(onDisk(path) < 4 * 1024 * 1024, `still ${onDisk(path)} bytes`), {
		timeout: 20_000,
		interval: 50,
	});
	assert.equal(await autoVacuum(path), 2, "incremental");
});

test("a store from before that holds messages is not converted while they wait, only once it is opened empty", async () => {
	const path = join(directory(), "ended-child-queue.sqlite");
	const holding = await open(path, "broker-1");
	await holding.add(entry("waiting"));
	await holding.close();
	// As a broker of the earlier release left it: no auto-vacuum, a message waiting.
	const { DatabaseSync } = await import("node:sqlite");
	const earlier = new DatabaseSync(path);
	earlier.exec("PRAGMA auto_vacuum = NONE; VACUUM;");
	earlier.close();
	// Opened with a message waiting: rewriting it now would cost as much as the queue holds.
	const busy = await open(path, "broker-3");
	assert.equal(await autoVacuum(path), 0);
	await busy.load();
	await fillAndDrain(busy, 8);
	await busy.remove(["waiting"]);
	await sleep(500);
	assert.equal(await autoVacuum(path), 0, "not converted while it runs");
	await busy.close();
	const empty = await open(path, "broker-4");
	assert.equal(await autoVacuum(path), 2, "converted when opened empty");
	await vi.waitFor(() => assert.ok(onDisk(path) < 4 * 1024 * 1024, `still ${onDisk(path)} bytes`), {
		timeout: 20_000,
		interval: 50,
	});
	await empty.close();
});

test("giving space back after a drain never waits for another process's write lock: a message sent once it is free is kept", async () => {
	const path = join(directory(), "ended-child-queue.sqlite");
	const database = await openNodeSqliteDatabase(path);
	const store = await openSqlEndedChildQueueStore(
		{ database, prefix: "" },
		{ home: "local", holder: "broker-1", lockWaitMs: 1_000, compact: true },
	);
	// Another process takes the write lock while the store tidies up after a drain (once the freed pages are folded
	// into the file), and holds it for longer than a message write waits for it.
	const { DatabaseSync } = await import("node:sqlite");
	let other: InstanceType<typeof DatabaseSync> | undefined;
	let lockedAt = 0;
	const exec = database.exec.bind(database);
	database.exec = async (sql) => {
		await exec(sql);
		if (other === undefined && /wal_checkpoint/i.test(sql)) {
			other = new DatabaseSync(path);
			other.exec("BEGIN IMMEDIATE");
			lockedAt = performance.now();
			setTimeout(() => {
				other!.exec("ROLLBACK");
				other!.close();
			}, 1_300);
		}
	};
	await fillAndDrain(store, 4);
	await vi.waitFor(() => assert.ok(other !== undefined, "the store tidied up"), { timeout: 10_000, interval: 10 });
	await sleep(lockedAt + 1_400 - performance.now());
	// The lock is free again: a message sent now is kept, at once: within less than a lock wait (its commit syncs the file,
	// which a loaded host takes a while to do).
	const started = performance.now();
	assert.equal(await store.add(entry("after")), "added");
	assert.ok(performance.now() - started < 1_000, `kept after ${(performance.now() - started).toFixed(0)} ms`);
	await store.close();
	await database.close();
});

test("a small drain with no space to give back costs no transaction beyond its writes, nor does opening an empty store", async () => {
	const path = join(directory(), "ended-child-queue.sqlite");
	const database = await openNodeSqliteDatabase(path);
	let transactions = 0;
	const transaction = database.transaction.bind(database);
	database.transaction = ((callback, options) => {
		if (options?.readOnly !== true) transactions += 1;
		return transaction(callback, options);
	}) as typeof database.transaction;
	let maintenance = 0;
	const maintain = database.tryMaintenance!.bind(database);
	database.tryMaintenance = async (callback) => {
		const ran = await maintain(callback);
		if (ran) maintenance += 1;
		return ran;
	};
	const store = await openSqlEndedChildQueueStore(
		{ database, prefix: "" },
		{ home: "local", holder: "broker-1", compact: true },
	);
	await sleep(300);
	const opened = transactions;
	for (let index = 0; index < 20; index++) {
		await store.add(entry(`m${index}`));
		await store.remove([`m${index}`]);
	}
	await sleep(300);
	await store.close();
	// One for each message written and one for each removed, as without giving space back.
	assert.equal(transactions - opened, 40);
	assert.equal(maintenance, 0, "no housekeeping transaction, at open or after a drain");
	await database.close();
});

/**
 * The longest the event loop may stop while the store waits out another process's lock, beyond what the whole host
 * stood still meanwhile. Waiting for the lock on the event loop stops it for the whole wait (5 s), and a store that spins
 * never lets it run again; a Windows host can stand still for seconds, every process at once, which the heartbeat on
 * another thread measures, and what is left of a loaded host's scheduling stays well under this. (A write that commits
 * afterwards syncs the file on the event loop, which a loaded Windows host takes over 200 ms to do: that is not waiting
 * for the lock, and is bounded by the test's other checks.)
 */
const STALL_BEYOND_HOST_MAX_MS = 200;
/** Room for a timer that fires early by the event loop's own lag, on a wait as long as the store's lock wait. */
const TIMER_LAG_MARGIN_MS = 1_000;

/**
 * The longest the whole host stood still since it started: a heartbeat on another thread, which keeps running while
 * this one works or waits. A stall of this thread alone does not stop it.
 */
function hostStallClock(): { longestMs(): number; stop(): Promise<number> } {
	const longest = new Float64Array(new SharedArrayBuffer(8));
	const worker = new Worker(
		`const { workerData } = require("node:worker_threads");
const longest = new Float64Array(workerData);
let last = performance.now();
setInterval(() => {
	const now = performance.now();
	longest[0] = Math.max(longest[0], now - last);
	last = now;
}, 5);`,
		{ eval: true, workerData: longest.buffer },
	);
	return {
		longestMs: () => longest[0]!,
		stop: async () => {
			await worker.terminate();
			return longest[0]!;
		},
	};
}

test("after a write waits out another process's lock and the next is refused at once, later writes go through and the store closes", async () => {
	const path = join(directory(), "ended-child-queue.sqlite");
	// Opened as a broker opens it: its writes wait 5 s for another process's write lock.
	const store = await openLocalEndedChildQueueStore(path, "broker-1");
	const host = hostStallClock();
	let last = performance.now();
	let stalled = 0;
	let stalledWaiting = Number.POSITIVE_INFINITY;
	let hostStalledWaiting = 0;
	const ticker = setInterval(() => {
		const now = performance.now();
		stalled = Math.max(stalled, now - last);
		last = now;
	}, 5);
	const { DatabaseSync } = await import("node:sqlite");
	const other = new DatabaseSync(path);
	other.exec("BEGIN IMMEDIATE");
	try {
		try {
			await assert.rejects(store.add(entry("m1")), /locked/, "the first write waits out the lock, then fails");
			await assert.rejects(store.add(entry("m2")), /locked/, "the next one, within a lock wait, fails at once");
		} finally {
			other.exec("ROLLBACK");
			other.close();
		}
		// While the store waited out the lock, the event loop ran (checked once the store is closed).
		stalledWaiting = stalled;
		hostStalledWaiting = host.longestMs();
		// Writes are refused at once for a lock wait after the first failed; that wait is over once this one is (with room
		// for a timer that fires early by the event loop's own lag).
		await sleep(ENDED_QUEUE_LOCK_WAIT_MS + TIMER_LAG_MARGIN_MS);
		// The lock is free and the wait is over: a write now is kept, and a remove goes through.
		const settled = (write: Promise<unknown>) =>
			Promise.race([write, sleep(ENDED_QUEUE_LOCK_WAIT_MS).then(() => "still waiting")]);
		assert.equal(await settled(store.add(entry("m3"))), "added");
		assert.equal(await settled(store.remove(["m3"])), undefined);
		assert.equal(await settled(store.close().then(() => "closed")), "closed");
	} finally {
		clearInterval(ticker);
	}
	const hostStalled = await host.stop();
	assert.ok(
		stalledWaiting - hostStalledWaiting < STALL_BEYOND_HOST_MAX_MS,
		`the event loop stalled for ${stalledWaiting.toFixed(1)} ms while the store waited out the lock, the whole host for ${hostStalledWaiting.toFixed(1)} ms`,
	);
	assert.ok(
		stalled - hostStalled < TIMER_LAG_MARGIN_MS,
		`the event loop stalled for ${stalled.toFixed(1)} ms, the whole host for ${hostStalled.toFixed(1)} ms`,
	);
}, 60_000);

test("the store still gives its disk space back after another process held its write lock", async () => {
	const path = join(directory(), "ended-child-queue.sqlite");
	const database = await openNodeSqliteDatabase(path, { lockWaitMs: 300 });
	const store = await openSqlEndedChildQueueStore(
		{ database, prefix: "" },
		{ home: "local", holder: "broker-1", lockWaitMs: 300, compact: true },
	);
	// Another process holds the write lock: a message's write waits for it, and fails.
	const { DatabaseSync } = await import("node:sqlite");
	const other = new DatabaseSync(path);
	other.exec("BEGIN IMMEDIATE");
	await assert.rejects(store.add(entry("refused")));
	other.exec("ROLLBACK");
	other.close();
	// Once the breaker's wait is over (twice it, for a timer that fires early), a queue fills and drains: its space is
	// given back as before.
	await sleep(2 * 300);
	await fillAndDrain(store, 8);
	await vi.waitFor(() => assert.ok(onDisk(path) < 4 * 1024 * 1024, `still ${onDisk(path)} bytes`), {
		timeout: 20_000,
		interval: 50,
	});
	await store.close();
	await database.close();
});

test("a message whose delete failed, queued again and refused, is still deleted once another process lets go of the lock", async () => {
	const path = join(directory(), "ended-child-queue.sqlite");
	const database = await openNodeSqliteDatabase(path, { lockWaitMs: 300 });
	const store = await openSqlEndedChildQueueStore(
		{ database, prefix: "" },
		{ home: "local", holder: "broker-1", lockWaitMs: 300, compact: true },
	);
	const key = { ownerSessionId: "owner-1", ownerHost: "owner-host", childKey: "subagent-worker-1" };
	await store.add(entry("m1"));
	// Another process holds the write lock: the delete of the delivered message fails, and so does a retry of the same
	// message by its sender.
	const { DatabaseSync } = await import("node:sqlite");
	const other = new DatabaseSync(path);
	other.exec("BEGIN IMMEDIATE");
	try {
		await assert.rejects(store.remove(["m1"]));
		await assert.rejects(store.add(entry("m1")));
	} finally {
		other.exec("ROLLBACK");
		other.close();
	}
	// The lock is free for good: the delete goes through, and the message no longer counts.
	await vi.waitFor(
		async () => {
			assert.deepEqual((await store.load()).rows, []);
			assert.equal(store.counted(key).total, 0);
		},
		{ timeout: 30_000, interval: 100 },
	);
	await store.close();
	await database.close();
});

test("counting what a store kept asks its database a page of rows at a time, however far apart the rows' sequence numbers are", async () => {
	const path = join(directory(), "ended-child-queue.sqlite");
	const earlier = await open(path, "broker-1");
	await earlier.add(entry("old"));
	await earlier.add(entry("new"));
	await earlier.close();
	// A shared database numbers the rows of every home in one sequence, never reused: millions apart, in time.
	const { DatabaseSync } = await import("node:sqlite");
	const raw = new DatabaseSync(path);
	raw.exec("UPDATE intercom_ended_child_queue SET seq = 4000000 WHERE message_id = 'new'");
	raw.close();
	const database = await openNodeSqliteDatabase(path);
	let statements = 0;
	for (const method of ["all", "get", "run", "exec"] as const) {
		const call = database[method].bind(database) as (...args: unknown[]) => Promise<unknown>;
		(database as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
			statements += 1;
			return call(...args);
		};
	}
	const store = await openSqlEndedChildQueueStore(
		{ database, prefix: "" },
		{ home: "local", holder: "broker-2", ownsDatabase: true },
	);
	await store.whenCounted();
	// Each round trip to a remote database counts against how long a message waits for the count.
	assert.ok(statements < 20, `${statements} statements to open a store of 2 rows and count them`);
	assert.deepEqual(
		store.counted({ ownerSessionId: "owner-1", ownerHost: "owner-host", childKey: "subagent-worker-1" }),
		{ child: 10, total: 10, counting: false },
	);
	await store.close();
});

/** How many statements opening a store at `path` sends its database, until the open resolves. */
async function statementsToOpen(path: string): Promise<number> {
	const database = await openNodeSqliteDatabase(path);
	let statements = 0;
	for (const method of ["all", "get", "run", "exec", "transaction"] as const) {
		const call = database[method].bind(database) as (...args: unknown[]) => Promise<unknown>;
		(database as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
			statements += 1;
			return call(...args);
		};
	}
	const store = await openSqlEndedChildQueueStore(
		{ database, prefix: "" },
		{ home: "local", holder: "broker-2", ownsDatabase: true, compact: true },
	);
	const opened = statements;
	await store.close();
	return opened;
}

test("opening a store reads none of the rows it kept: a broker decides on a full store as soon as on an empty one", async () => {
	const empty = join(directory(), "ended-child-queue.sqlite");
	await (await open(empty, "broker-1")).add(entry("one"));
	const full = join(directory(), "ended-child-queue.sqlite");
	const earlier = await open(full, "broker-1");
	await Promise.all(Array.from({ length: 20_000 }, (_, index) => earlier.add(entry(`m${index}`))));
	await earlier.close();
	for (const store of opened.splice(0)) await store.close();
	// On a cold disk, reading a full store's rows before deciding on it outlasted the broker's open wait.
	assert.equal(await statementsToOpen(full), await statementsToOpen(empty));
}, 60_000);

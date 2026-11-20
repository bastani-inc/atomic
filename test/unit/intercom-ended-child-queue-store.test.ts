import assert from "node:assert/strict";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test } from "vitest";
import {
	type EndedChildQueueStore,
	type EndedQueueEntry,
	openLocalEndedChildQueueStore,
	openSqlEndedChildQueueStore,
} from "../../packages/intercom/broker/sql-ended-child-queue-store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

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
		assert.ok(
			(behindFailedAt as number) < 300 * 2,
			`the one behind failed after ${behindFailedAt} ms, not a second lock wait`,
		);
	} finally {
		other.exec("ROLLBACK");
		other.close();
	}
	// The lock is free again: once the breaker's wait is over, writes go through.
	await new Promise((resolve) => setTimeout(resolve, 350));
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

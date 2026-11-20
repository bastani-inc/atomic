import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type net from "node:net";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import {
	DepartedChildren,
	type EndedChildMark,
	type JournalDeparture,
	type WakeSender,
} from "../../packages/intercom/broker/departed-children.js";
import { DurableEndedQueue } from "../../packages/intercom/broker/durable-ended-queue.js";
import {
	ENDED_CHILD_QUEUE_BYTES_MAX,
	ENDED_CHILD_QUEUE_BYTES_TOTAL_MAX,
	EndedChildWakeBudget,
	type EndedChildWakeFailure,
} from "../../packages/intercom/broker/ended-child-wakes.js";
import type { HeldSend } from "../../packages/intercom/broker/restoring-recipients.js";
import {
	type BrokerConnectedSession,
	detachSend,
	type SendClientMessage,
} from "../../packages/intercom/broker/send-handler.js";
import {
	type EndedChildQueueStore,
	openLocalEndedChildQueueStore,
	openSqlEndedChildQueueStore,
} from "../../packages/intercom/broker/sql-ended-child-queue-store.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

/**
 * Durable wake queue: the 32 MiB per-subagent and 256 MiB per-broker caps hold for what the store keeps on disk, also
 * when a delivered message's row cannot be deleted at once, while a restarted broker reads what an earlier one kept,
 * and when two departures of one subagent merge. The broker's own wiring of the queue and its departures, on a real
 * node:sqlite store.
 */

const OWNER = "owner-session";
const HOST = "owner-host";
const MiB = 1024 * 1024;
/** How long the store's writes wait for another process's lock in the tests that hold it. */
const LOCK_WAIT_MS = 300;
/** About 1 MiB where it is kept: its text, and its frame and sender as JSON. */
const TEXT = "x".repeat(MiB - 1024);

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {});
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

function storePath(): string {
	const made = makeTempDirectory("ended-child-queue-caps-");
	directories.push(made);
	return join(made, "ended-child-queue.sqlite");
}

function wakeSender(id: string, groups = ["default"]): WakeSender & BrokerConnectedSession {
	return {
		id,
		info: { id, name: id, cwd: "/repo", model: "m", pid: 1, startedAt: 1, lastActivity: 1, groups },
		waker: { id, name: id },
		socket: {} as net.Socket,
		registrationReturnAddress: `${id}-host`,
	} as WakeSender & BrokerConnectedSession;
}

/** A send to `child` that asks to wake it, as the broker took it from `sender`. */
function send(child: string, sender: BrokerConnectedSession, text = TEXT): HeldSend {
	const messageId = randomUUID();
	const clientMessage = {
		type: "send",
		to: child,
		wakeEndedRecipient: true,
		message: { id: messageId, timestamp: 1, content: { text } },
	} as unknown as SendClientMessage;
	detachSend(clientMessage, sender);
	return {
		socket: sender.socket,
		senderId: sender.info.id,
		messageId,
		clientMessage: clientMessage as HeldSend["clientMessage"],
		senderReturnAddress: sender.registrationReturnAddress,
	};
}

function paused(childName: string, group = "default"): EndedChildMark {
	return { childName, group, aliases: [], outcome: "stopped", childId: `${childName}:0`, messages: "hold" };
}

/**
 * A broker's queue of messages for subagents that ended, kept in the store at `path`, and its departures, wired as the
 * broker wires them. `lockWaitMs`: how long a write waits for another process's write lock.
 */
async function broker(
	path: string,
	options: {
		lockWaitMs?: number;
		whileLoading?: true;
		/** Counting what the store kept takes until this settles, as on a slow disk or a remote database. */
		countTakes?: Promise<void>;
	} = {},
) {
	const lockWaitMs = options.lockWaitMs ?? 5_000;
	const database = await openNodeSqliteDatabase(path, { busyTimeoutMs: lockWaitMs, lockWaitMs });
	const countTakes = options.countTakes;
	if (countTakes !== undefined) {
		const all = database.all.bind(database);
		database.all = (async (sql: string, ...params: Parameters<typeof database.all>[1][]) => {
			if (/SUM\(bytes\)/.test(sql)) await countTakes;
			return all(sql, ...params);
		}) as typeof database.all;
	}
	let retired = false;
	let store: EndedChildQueueStore | undefined;
	const failed: EndedChildWakeFailure[] = [];
	const logs: string[] = [];
	const budget = new EndedChildWakeBudget();
	const queue = new DurableEndedQueue({
		openStore: async () => {
			store = await openSqlEndedChildQueueStore(
				{ database, prefix: "" },
				{ home: "local", holder: randomUUID(), ownsDatabase: true, lockWaitMs, compact: true },
			);
			return store;
		},
		routingStarted: () => undefined,
		retireStore: () => {
			retired = true;
		},
		budget,
		delivered: () => "unknown",
		log: (text) => logs.push(text),
	});
	cleanups.push(() => queue.close());
	const live = new Set<string>([OWNER]);
	const departed: DepartedChildren = new DepartedChildren(() => {}, undefined, undefined, undefined, {
		failed: (failures) => failed.push(...failures),
		budget,
		ownerLive: (id) => live.has(id),
		ownerHost: (id) => (live.has(id) ? HOST : undefined),
		journal: queue.journal,
		storedBytes: (held) => queue.storedBytes(held),
		storedCounts: (departure) => queue.storedCounts(departure),
	});
	await queue.decide((restored) => departed.restore(restored.queues, () => OWNER));
	assert.equal(queue.durable, true, "the store opened");
	assert.equal(retired, false, "the store is kept");
	// As the broker does: sends wait until what an earlier broker kept is taken up again; only a test of that window
	// goes on at once.
	if (options.whileLoading !== true) await queue.untilLoaded();
	return { database, queue, departed, failed, live, logs };
}

/** The bytes the store keeps for messages, as written there (all of them, or those for one subagent). */
async function storedOnDisk(path: string, child?: string): Promise<number> {
	const { DatabaseSync } = await import("node:sqlite");
	const reader = new DatabaseSync(path, { readOnly: true });
	try {
		const row = reader
			.prepare(
				`SELECT COALESCE(SUM(LENGTH(CAST(b.request_json AS BLOB)) + LENGTH(CAST(q.sender_json AS BLOB))), 0) AS bytes
				 FROM intercom_ended_child_queue q JOIN intercom_ended_child_bodies b ON b.message_id = q.message_id
				 ${child === undefined ? "" : "WHERE q.child_key = ?"}`,
			)
			.get(...(child === undefined ? [] : [child])) as { bytes: number };
		return row.bytes;
	} finally {
		reader.close();
	}
}

/** The sizes the store's rows recorded when they were written, summed: what a store counts when it opens. */
async function countedOnDisk(path: string): Promise<number> {
	const { DatabaseSync } = await import("node:sqlite");
	const reader = new DatabaseSync(path, { readOnly: true });
	try {
		const row = reader.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM intercom_ended_child_queue").get() as {
			bytes: number;
		};
		return Number(row.bytes);
	} finally {
		reader.close();
	}
}

async function rowsOnDisk(path: string, messageIds: readonly string[]): Promise<number> {
	const { DatabaseSync } = await import("node:sqlite");
	const reader = new DatabaseSync(path, { readOnly: true });
	try {
		let found = 0;
		for (const id of messageIds)
			if (reader.prepare("SELECT 1 FROM intercom_ended_child_queue WHERE message_id = ?").get(id) !== undefined)
				found += 1;
		return found;
	} finally {
		reader.close();
	}
}

/** Send `count` messages of about 1 MiB to `child`; returns the kept promises of those queued and the refusals. */
function sendMany(
	departed: DepartedChildren,
	child: string,
	from: WakeSender & BrokerConnectedSession,
	count: number,
	text = TEXT,
) {
	const kept: Array<Promise<unknown>> = [];
	const refusals: string[] = [];
	const queued: string[] = [];
	for (let index = 0; index < count; index++) {
		const held = send(child, from, text);
		const admission = departed.admitWake(child, from, held);
		if (admission.kind === "queued") {
			queued.push(held.messageId);
			if (admission.kept !== undefined) kept.push(admission.kept);
		} else if (admission.kind === "refused") refusals.push(admission.reason);
		else assert.fail(`not decided as a queued send: ${admission.kind}`);
	}
	return { kept, refusals, queued };
}

test("a delivered message whose row another process's lock kept from being deleted counts against its subagent's 32 MiB until the delete, retried once the lock is free, goes through", async () => {
	const path = storePath();
	const { departed, queue, logs } = await broker(path, { lockWaitMs: LOCK_WAIT_MS });
	const child = "subagent-worker-caps-1";
	const sender = wakeSender("peer");
	departed.mark(OWNER, [paused(child)]);
	const first = sendMany(departed, child, sender, 30);
	assert.deepEqual(first.refusals, []);
	await Promise.all(first.kept);
	// Another process holds the write lock while the subagent is continued and confirms each message: deleting
	// their rows waits out the lock, and fails.
	const { DatabaseSync } = await import("node:sqlite");
	const other = new DatabaseSync(path);
	other.exec("BEGIN IMMEDIATE");
	const taken = departed.registered(child, new Set(["default"]), OWNER);
	assert.equal(taken.length, 30);
	queue.settled(taken.map((held) => held.messageId));
	await vi.waitFor(() => assert.ok(logs.some((line) => /could not update a message kept/.test(line))), {
		timeout: 30_000,
		interval: 20,
	});
	// The lock wait since the failed delete is over (until then the writes are refused at once; twice that, for a timer
	// that fires early by the event loop's own lag); the lock is still held.
	await sleep(2 * LOCK_WAIT_MS);
	other.exec("ROLLBACK");
	other.close();
	// It is paused again at once, and senders send as much again: the rows still on disk count.
	departed.mark(OWNER, [paused(child)]);
	const second = sendMany(departed, child, sender, 30);
	await Promise.allSettled(second.kept);
	const kept = await storedOnDisk(path, child);
	assert.ok(kept <= ENDED_CHILD_QUEUE_BYTES_MAX + MiB, `${kept} bytes kept for one subagent`);
	assert.ok(second.refusals.length > 0, "the rows of delivered messages still hold the cap");
	assert.match(second.refusals[0]!, /The message was not queued for it: \d+ MiB of messages already wait for it\./);
	// The delete is retried once the lock is free: the delivered rows go, and once that committed they no longer count,
	// so the queue takes messages again.
	await vi.waitFor(
		async () => {
			assert.equal(await rowsOnDisk(path, first.queued), 0);
			const counted = queue.storedCounts({
				ownerSessionId: OWNER,
				ownerHost: HOST,
				childKey: child,
			} as JournalDeparture);
			assert.ok((counted?.child ?? 0) + MiB <= ENDED_CHILD_QUEUE_BYTES_MAX, "the delivered rows no longer count");
		},
		{ timeout: 30_000, interval: 50 },
	);
	const third = sendMany(departed, child, sender, 1);
	assert.deepEqual(third.refusals, [], "counted again from what is kept");
	await Promise.all(third.kept);
}, 60_000);

test("a restarted broker counts what an earlier one kept before it queues anything: a burst while it reads them stays within 256 MiB", async () => {
	const path = storePath();
	// An earlier broker kept 255 messages that each took 1 MiB where it kept them, for 8 subagents. (Each row records
	// the size its message took when written, which is what a store counts when it opens; these are written small, to
	// spare the disk.)
	const earlier = await openLocalEndedChildQueueStore(path, "broker-1");
	const sender = wakeSender("peer");
	const adds: Array<Promise<unknown>> = [];
	for (let index = 0; index < 255; index++) {
		const child = `subagent-worker-kept-${index % 8}`;
		const held = send(child, sender, "kept");
		const requestJson = JSON.stringify(held.clientMessage);
		const senderJson = JSON.stringify({
			info: sender.info,
			registrationReturnAddress: sender.registrationReturnAddress,
		});
		adds.push(
			earlier.add({
				messageId: held.messageId,
				ownerSessionId: OWNER,
				ownerHost: HOST,
				childKey: child,
				child: {
					childName: child,
					group: "default",
					aliases: [],
					childId: `${child}:0`,
					outcome: "stopped",
					messages: "hold",
				},
				sender: JSON.parse(senderJson) as Record<string, unknown>,
				request: JSON.parse(requestJson) as Record<string, unknown>,
				requestJson,
				senderJson,
				bytes: MiB,
				queuedAt: Date.now(),
			}),
		);
	}
	await Promise.all(adds);
	await earlier.close();
	assert.equal(await countedOnDisk(path), 255 * MiB);
	// The next broker: as soon as it decided on the store, another subagent of the owner departs, sends to it wait
	// for the owner's verdict, and the owner reports it paused, while the kept ones may not be counted yet: they wait
	// for the count, as the broker has them wait, and are decided then.
	const { departed, queue } = await broker(path, { whileLoading: true });
	const child = "subagent-worker-burst-1";
	departed.depart({ ownerSessionId: OWNER, childName: child, group: "default", aliases: [] });
	for (let index = 0; index < 10; index++) {
		const held = send(child, sender);
		assert.equal(departed.admit(child, sender, held, true, sender).kind, "held");
	}
	const marked = departed.mark(OWNER, [paused(child)]);
	const kept: Array<Promise<unknown>> = marked.queued.flatMap((queued) =>
		queued.kept === undefined ? [] : [queued.kept],
	);
	const refusals = marked.refused.map((refusal) => refusal.reason ?? "");
	if (marked.uncounted.length > 0) {
		await queue.untilCounted();
		for (const held of marked.uncounted) {
			const admission = departed.admitWake(child, sender, held, false, true);
			if (admission.kind === "queued" && admission.kept !== undefined) kept.push(admission.kept);
			else if (admission.kind === "refused") refusals.push(admission.reason);
		}
	}
	await Promise.allSettled(kept);
	await queue.untilLoaded();
	const counted = await countedOnDisk(path);
	assert.ok(counted <= ENDED_CHILD_QUEUE_BYTES_TOTAL_MAX + MiB, `${counted} bytes kept in all`);
	assert.ok(refusals.length > 0);
	assert.match(
		refusals[0]!,
		/The message was not queued for it: Intercom already keeps \d+ MiB of messages for subagents that ended\./,
	);
}, 60_000);

/** An earlier broker kept `count` messages for `child` that each took 1 MiB where it kept them (written small). */
async function keptEarlier(path: string, child: string, count: number): Promise<void> {
	const earlier = await openLocalEndedChildQueueStore(path, "broker-earlier");
	const sender = wakeSender("peer");
	for (let index = 0; index < count; index++) {
		const held = send(child, sender, "kept");
		const requestJson = JSON.stringify(held.clientMessage);
		const senderJson = JSON.stringify({
			info: sender.info,
			registrationReturnAddress: sender.registrationReturnAddress,
		});
		await earlier.add({
			messageId: held.messageId,
			ownerSessionId: OWNER,
			ownerHost: HOST,
			childKey: child,
			child: {
				childName: child,
				group: "default",
				aliases: [],
				childId: `${child}:0`,
				outcome: "stopped",
				messages: "hold",
			},
			sender: JSON.parse(senderJson) as Record<string, unknown>,
			request: JSON.parse(requestJson) as Record<string, unknown>,
			requestJson,
			senderJson,
			bytes: MiB,
			queuedAt: Date.now(),
		});
	}
	await earlier.close();
}

test("a restarted broker keeps its store however long counting what it kept takes; a message that may not fit waits for the count, then is decided", async () => {
	const path = storePath();
	const child = "subagent-worker-counted-1";
	await keptEarlier(path, child, 32);
	let finishCount: () => void = () => {};
	const countTakes = new Promise<void>((resolve) => {
		finishCount = resolve;
	});
	cleanups.unshift(async () => finishCount());
	// The broker decides on the store and keeps it while the count has not even started reading.
	const { departed, queue } = await broker(path, { whileLoading: true, countTakes });
	const sender = wakeSender("peer");
	departed.mark(OWNER, [paused(child), paused("subagent-worker-counted-2")]);
	// Neither its subagent's nor the broker's count is known yet: the message waits for it, as the broker has it wait.
	const held = send(child, sender, "after the restart");
	assert.equal(departed.admitWake(child, sender, held).kind, "uncounted");
	const elsewhere = send("subagent-worker-counted-2", sender, "after the restart");
	assert.equal(departed.admitWake("subagent-worker-counted-2", sender, elsewhere).kind, "uncounted");
	finishCount();
	await queue.untilCounted();
	// Counted: what was kept for the first fills its 32 MiB; the second has room.
	const decided = departed.admitWake(child, sender, held, false, true);
	assert.equal(decided.kind, "refused");
	assert.match(
		(decided as { reason: string }).reason,
		/The message was not queued for it: 32 MiB of messages already wait for it\./,
	);
	const other = departed.admitWake("subagent-worker-counted-2", sender, elsewhere, false, true);
	assert.equal(other.kind, "queued");
	await (other as { kept?: Promise<unknown> }).kept;
	await queue.untilLoaded();
	assert.ok((await countedOnDisk(path)) > 32 * MiB, "every kept row is still there, and the one queued");
}, 60_000);

test("a message that may not fit is refused with the cap's reason when counting what the store kept outlasts the store's open wait", async () => {
	const path = storePath();
	const child = "subagent-worker-uncounted-1";
	await keptEarlier(path, child, 1);
	let finishCount: () => void = () => {};
	const countTakes = new Promise<void>((resolve) => {
		finishCount = resolve;
	});
	cleanups.unshift(async () => finishCount());
	const { departed, queue } = await broker(path, { whileLoading: true, countTakes });
	const sender = wakeSender("peer");
	departed.mark(OWNER, [paused(child)]);
	const held = send(child, sender, "after the restart");
	assert.equal(departed.admitWake(child, sender, held).kind, "uncounted");
	// The count never ends in time: the wait for it does.
	await queue.untilCounted();
	const decided = departed.admitWake(child, sender, held, false, true);
	assert.equal(decided.kind, "refused");
	assert.match(
		(decided as { reason: string }).reason,
		/The message was not queued for it: 32 MiB of messages already wait for it\./,
	);
	finishCount();
}, 60_000);

test("two departures of one subagent, merged when its launching session comes back, never keep more than its 32 MiB, and a merge keeps every message it took", async () => {
	const path = storePath();
	const { departed, failed, live } = await broker(path);
	const child = "subagent-worker-merge-1";
	// The same host session, connected twice at once (its old connection not yet closed), reports the child from
	// each, in another group each time: senders of each group reach their own departure of it.
	const later = "owner-session-2";
	live.add(later);
	departed.mark(OWNER, [paused(child, "group-a")]);
	departed.mark(later, [paused(child, "group-b")]);
	const fromA = sendMany(departed, child, wakeSender("peer-a", ["group-a"]), 20);
	const fromB = sendMany(departed, child, wakeSender("peer-b", ["group-b"]), 20);
	await Promise.allSettled([...fromA.kept, ...fromB.kept]);
	const kept = await storedOnDisk(path, child);
	assert.ok(kept <= ENDED_CHILD_QUEUE_BYTES_MAX + MiB, `${kept} bytes kept for one subagent`);
	// The old connection closes, and the session takes over what it kept for the child.
	live.delete(OWNER);
	departed.dropOwner(OWNER, HOST);
	departed.adoptOrphans(later, HOST);
	assert.deepEqual(failed, [], "every message it took is kept");
	const taken = departed.registered(child, new Set(["group-b"]), later);
	assert.deepEqual(
		new Set(taken.map((held) => held.messageId)),
		new Set([...fromA.queued, ...fromB.queued]),
		"each message queued reaches the subagent",
	);
}, 60_000);

test("a merge that takes a subagent past its 32 MiB keeps every message and refuses new ones until it drains below", async () => {
	// Memory only: each departure counts its own queue.
	const failed: EndedChildWakeFailure[] = [];
	const live = new Set([OWNER, "owner-session-2"]);
	const departed = new DepartedChildren(() => {}, undefined, undefined, undefined, {
		failed: (failures) => failed.push(...failures),
		ownerLive: (id) => live.has(id),
		ownerHost: () => HOST,
	});
	const child = "subagent-worker-merge-2";
	departed.mark(OWNER, [paused(child, "group-a")]);
	departed.mark("owner-session-2", [paused(child, "group-b")]);
	const a = sendMany(departed, child, wakeSender("peer-a", ["group-a"]), 20);
	const b = sendMany(departed, child, wakeSender("peer-b", ["group-b"]), 20);
	assert.deepEqual([...a.refusals, ...b.refusals], []);
	live.delete(OWNER);
	departed.dropOwner(OWNER, HOST);
	departed.adoptOrphans("owner-session-2", HOST);
	assert.deepEqual(failed, []);
	const refused = sendMany(departed, child, wakeSender("peer-b", ["group-b"]), 1);
	assert.match(
		refused.refusals[0] ?? "",
		/The message was not queued for it: \d+ MiB of messages already wait for it\./,
	);
	assert.equal(departed.registered(child, new Set(["group-b"]), "owner-session-2").length, 40);
});

test("a message the store's file has no room left for is refused saying the queue is full; the store keeps working", async () => {
	const path = storePath();
	const { database, departed } = await broker(path, { lockWaitMs: 1_000 });
	const child = "subagent-worker-full-1";
	const sender = wakeSender("peer");
	departed.mark(OWNER, [paused(child)]);
	const small = sendMany(departed, child, sender, 1);
	await Promise.all(small.kept);
	// The file may grow by a few pages only: a 1 MiB message does not fit.
	const pages = await database.get<{ page_count: number }>("PRAGMA page_count");
	await database.exec(`PRAGMA max_page_count = ${(pages?.page_count ?? 0) + 16}`);
	const big = sendMany(departed, child, sender, 1);
	assert.equal(big.kept.length, 1, "queued at first: the caps admit it");
	await assert.rejects(
		big.kept[0]!,
		/The message was not queued for it: Intercom already keeps 256 MiB of messages for subagents that ended\./,
	);
	// A message that fits is kept: the refusal broke nothing that later writes would be refused for.
	const after = sendMany(departed, child, sender, 1, "small");
	await Promise.all(after.kept);
}, 60_000);

test("a failure kept for a sender that is away keeps only what telling it needs, not the message", async () => {
	const path = storePath();
	const store = await openLocalEndedChildQueueStore(path, "broker-1");
	cleanups.push(() => store.close());
	const sender = wakeSender("peer");
	const held = send("subagent-worker-failed-1", sender);
	const requestJson = JSON.stringify({ ...held.clientMessage, logicalTarget: "worker" });
	const senderJson = JSON.stringify({
		info: sender.info,
		registrationReturnAddress: sender.registrationReturnAddress,
	});
	await store.add({
		messageId: held.messageId,
		ownerSessionId: OWNER,
		ownerHost: HOST,
		childKey: "subagent-worker-failed-1",
		child: {
			childName: "subagent-worker-failed-1",
			group: "default",
			aliases: [],
			outcome: "stopped",
			messages: "hold",
		},
		sender: JSON.parse(senderJson) as Record<string, unknown>,
		request: JSON.parse(requestJson) as Record<string, unknown>,
		requestJson,
		senderJson,
		bytes: Buffer.byteLength(requestJson) + Buffer.byteLength(senderJson),
		queuedAt: 1,
	});
	await store.fail(held.messageId, "its launching session ended", 7_000);
	assert.ok((await storedOnDisk(path)) < 1024, `${await storedOnDisk(path)} bytes kept for a failure`);
	const [row] = (await store.load()).rows;
	assert.ok(row);
	assert.deepEqual(row.failed, { reason: "its launching session ended", at: 7_000 });
	assert.equal(row.request.logicalTarget, "worker");
	assert.equal(row.request.to, "subagent-worker-failed-1");
	assert.equal((row.sender as { info: { id: string } }).info.id, "peer");
	assert.equal((row.sender as { registrationReturnAddress: string }).registrationReturnAddress, "peer-host");
});

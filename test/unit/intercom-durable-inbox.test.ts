import assert from "node:assert/strict";
import type { SessionEntry } from "@bastani/atomic";
import { test } from "vitest";
import {
	DurableInbox,
	INTERCOM_INBOX_ENTRY,
	type IntercomInboxRecord,
	unconsumedIntercomInbox,
} from "../../packages/intercom/durable-inbox.js";
import { InboundIdleQueue } from "../../packages/intercom/inbound-idle-queue.js";
import type { InboundMessageEntry } from "../../packages/intercom/intercom-utils.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

const peer: SessionInfo = {
	id: "peer",
	name: "peer",
	cwd: "/tmp",
	model: "test",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};

function message(id: string, timestamp = 1): Message {
	return { id, timestamp, content: { text: `body ${id}` } };
}

function inboxEntry(record: IntercomInboxRecord): SessionEntry {
	return {
		type: "custom",
		id: `inbox-${record.message.id}-${record.receivedAt}`,
		parentId: null,
		timestamp: new Date(record.receivedAt).toISOString(),
		customType: INTERCOM_INBOX_ENTRY,
		data: record,
	};
}

function shownEntry(id: string): SessionEntry {
	return {
		type: "custom_message",
		id: `card-${id}`,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: "intercom_message",
		content: `body ${id}`,
		display: true,
		details: { from: peer, message: message(id), bodyText: `body ${id}` },
	};
}

function queued(id: string, timestamp = 1): InboundMessageEntry {
	return { from: peer, message: message(id, timestamp), bodyText: `body ${id}` };
}

test("a busy recipient saves an arriving message, then confirms it, then queues it (#3761)", async () => {
	const steps: string[] = [];
	const saved = Promise.withResolvers<void>();
	const entries: SessionEntry[] = [];
	const inbox = new DurableInbox({
		durable: () => true,
		entries: () => entries,
		append: async (record) => {
			steps.push(`append:${record.message.id}`);
			await saved.promise;
			entries.push(inboxEntry(record));
			steps.push(`saved:${record.message.id}`);
		},
		now: () => 42,
	});
	const queue = new InboundIdleQueue();
	const arrival = inbox
		.receive(peer, message("m1"), undefined, () => steps.push("ack:m1"))
		.then((outcome) => {
			if (outcome === "fresh") queue.enqueue(queued("m1"));
			steps.push(`enqueue:${outcome}`);
		});
	await Promise.resolve();
	assert.deepEqual(steps, ["append:m1"], "nothing is confirmed or queued before the save finishes");
	saved.resolve();
	await arrival;
	assert.deepEqual(steps, ["append:m1", "saved:m1", "ack:m1", "enqueue:fresh"]);
	assert.equal(queue.size, 1);
	assert.deepEqual(
		entries.map((entry) => (entry.type === "custom" ? entry.data : undefined)),
		[{ message: message("m1"), from: peer, receivedAt: 42 }],
	);
});

test("a redelivered message already in the inbox is confirmed again without a second save (#3761)", async () => {
	const appended: string[] = [];
	const acks: string[] = [];
	const entries: SessionEntry[] = [inboxEntry({ message: message("persisted"), from: peer, receivedAt: 1 })];
	const inbox = new DurableInbox({
		durable: () => true,
		entries: () => entries,
		append: async (record) => {
			appended.push(record.message.id);
		},
	});
	assert.equal(
		await inbox.receive(peer, message("persisted"), undefined, () => acks.push("persisted")),
		"redelivered",
	);
	assert.equal(await inbox.receive(peer, message("live"), undefined, () => acks.push("live")), "fresh");
	assert.equal(await inbox.receive(peer, message("live"), undefined, () => acks.push("live")), "redelivered");
	assert.deepEqual(appended, ["live"]);
	assert.deepEqual(acks, ["persisted", "live", "live"]);
});

test("a message the recipient could not save is not confirmed, and an unsaved session confirms without saving (#3761)", async () => {
	const acks: string[] = [];
	const failing = new DurableInbox({
		durable: () => true,
		entries: () => [],
		append: async () => {
			throw new Error("disk full");
		},
	});
	assert.equal(await failing.receive(peer, message("lost"), undefined, () => acks.push("lost")), "unsaved");
	assert.equal(acks.length, 0);

	let appends = 0;
	const memoryOnly = new DurableInbox({
		durable: () => false,
		entries: () => [],
		append: async () => {
			appends += 1;
		},
	});
	assert.equal(await memoryOnly.receive(peer, message("ephemeral"), undefined, () => acks.push("ephemeral")), "fresh");
	assert.equal(appends, 0);
	assert.deepEqual(acks, ["ephemeral"]);
});

test("a message is shown once by id whichever of the idle flush, foreground detach or terminal barrier takes it (#3761)", () => {
	const consumed = new Set<string>();
	const queue = new InboundIdleQueue((id) => consumed.has(id));
	const first = queued("a", 1);
	assert.equal(queue.enqueue(first), true);
	assert.equal(queue.enqueue(queued("a", 1)), false, "a redelivered copy is not queued twice");

	// Foreground detach surfaced it and wrote its card; the barrier and idle flush must not show it again.
	assert.equal(queue.remove(first), true);
	consumed.add("a");
	assert.equal(queue.enqueue(queued("a", 1)), false, "a shown message is never queued again");

	const viaBarrier = queued("b", 2);
	const viaFlush = queued("c", 3);
	const shownElsewhere = queued("d", 4);
	queue.enqueue(viaBarrier);
	queue.enqueue(viaFlush);
	queue.enqueue(shownElsewhere);
	consumed.add("d");
	const claim = queue.claimOrdinarySourceTargets("run", [peer.id]);
	assert.deepEqual(
		claim.entries.map((entry) => entry.message.id),
		["b", "c"],
	);
	claim.rollbackFrom(1);
	consumed.add("b");
	assert.deepEqual(
		queue.drain().map((entry) => entry.message.id),
		["c"],
	);
	assert.equal(queue.remove(viaBarrier), false);
});

test("resume replays only unshown saved messages, once each, in the order they arrived (#3761)", () => {
	const record = (id: string, receivedAt: number): IntercomInboxRecord => ({
		message: message(id, 100 - receivedAt),
		from: peer,
		receivedAt,
	});
	const entries = [
		inboxEntry(record("third", 30)),
		inboxEntry(record("first", 10)),
		inboxEntry(record("shown", 5)),
		shownEntry("shown"),
		inboxEntry(record("second", 20)),
		inboxEntry(record("first", 40)),
	];
	assert.deepEqual(
		unconsumedIntercomInbox(entries).map((entry) => entry.message.id),
		["first", "second", "third"],
	);
});

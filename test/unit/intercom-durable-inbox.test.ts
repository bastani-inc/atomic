import assert from "node:assert/strict";
import type { SessionEntry } from "@bastani/atomic";
import { test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import type { ExtensionContext } from "../../packages/coding-agent/src/core/extensions/types.js";
import {
	DurableInbox,
	INTERCOM_INBOX_ENTRY,
	type IntercomInboxRecord,
	unconsumedIntercomInbox,
} from "../../packages/intercom/durable-inbox.js";
import { InboundIdleQueue } from "../../packages/intercom/inbound-idle-queue.js";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import type { IntercomExtensionTestOverrides } from "../../packages/intercom/intercom-test-seams.js";
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
		appendHandled: async () => {},
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
		appendHandled: async () => {},
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
		appendHandled: async () => {},
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
		appendHandled: async () => {},
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

function receivedEntry(id: string): SessionEntry {
	return {
		type: "custom",
		id: `received-${id}`,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: "intercom_received",
		data: { from: "peer", message: { text: `body ${id}` }, messageId: id, timestamp: 1 },
	};
}

test("resume does not replay a reply the waiting ask already recorded, but replays one it never recorded (#3761)", () => {
	const entries = [
		inboxEntry({ message: message("answered"), from: peer, receivedAt: 1 }),
		receivedEntry("answered"),
		inboxEntry({ message: message("crashed-before-record"), from: peer, receivedAt: 2 }),
	];
	assert.deepEqual(
		unconsumedIntercomInbox(entries).map((entry) => entry.message.id),
		["crashed-before-record"],
	);
});

interface ShownMessage {
	details?: { message?: { id?: string } };
}

/** A real Intercom runtime whose branch already holds the arrival's `intercom_inbox` entry, as receive saves it. */
async function runtimeWithSavedArrival(
	arrival: Message,
	context: { hasUI: boolean; ownsSubagentRun?: (runId: string) => boolean },
) {
	const branch: SessionEntry[] = [inboxEntry({ message: arrival, from: peer, receivedAt: 1 })];
	const shown: string[] = [];
	const handlers = new Map<string, Array<(event: object, ctx: ExtensionContext) => void | Promise<void>>>();
	let inbound!: Parameters<NonNullable<IntercomExtensionTestOverrides["captureInboundHandler"]>>[0];
	const show = (shownMessage: ShownMessage) => {
		shown.push(shownMessage.details?.message?.id ?? "?");
	};
	const pi = {
		on(name: string, handler: (event: object, ctx: ExtensionContext) => void | Promise<void>) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry(customType: string, data?: object) {
			branch.push({
				type: "custom",
				id: `entry-${branch.length}`,
				parentId: null,
				timestamp: new Date(0).toISOString(),
				customType,
				data,
			});
		},
		getSessionName: () => undefined,
		sendMessage: show,
		sendMessages: (messages: ShownMessage[]) => {
			for (const shownMessage of messages) show(shownMessage);
		},
		events: createEventBus(),
	};
	intercomHeavy(pi as never, {
		captureInboundHandler: (handler) => {
			inbound = handler;
		},
	});
	const ctx = {
		hasUI: context.hasUI,
		cwd: "/repo",
		isIdle: () => false,
		ui: { notify() {} },
		sessionManager: { getSessionId: () => "busy-recipient", getBranch: () => branch, getEntries: () => branch },
		...(context.ownsSubagentRun
			? {
					orchestrationContext: {
						kind: "workflow-stage",
						messageAdmission: { isOpen: () => false, boundary: { ownsSubagentRun: context.ownsSubagentRun } },
					},
				}
			: {}),
	} as unknown as ExtensionContext;
	const fire = async (name: string) => {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx);
	};
	await fire("session_start");
	return {
		branch,
		shown,
		handle: () => inbound(ctx, peer, arrival),
		close: () => fire("session_shutdown"),
	};
}

test("resume does not replay a message a busy non-interactive recipient already refused (#3761)", async () => {
	const runtime = await runtimeWithSavedArrival(message("refused"), { hasUI: false });
	try {
		await runtime.handle();
		assert.deepEqual(runtime.shown, [], "a busy non-interactive recipient refuses without showing the message");
		assert.deepEqual(unconsumedIntercomInbox(runtime.branch), []);
	} finally {
		await runtime.close();
	}
});

test("resume does not replay retired child traffic a closed workflow stage dropped (#3761)", async () => {
	const retired: Message = { ...message("retired-child"), source: { subagentRunId: "owned-run" } };
	const runtime = await runtimeWithSavedArrival(retired, {
		hasUI: true,
		ownsSubagentRun: (runId) => runId === "owned-run",
	});
	try {
		await runtime.handle();
		await vi.waitFor(() => assert.deepEqual(unconsumedIntercomInbox(runtime.branch), []));
		assert.deepEqual(runtime.shown, []);
	} finally {
		await runtime.close();
	}
});

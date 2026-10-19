import assert from "node:assert/strict";
import type { SessionEntry } from "@bastani/atomic";
import { test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import type { ExtensionContext } from "../../packages/coding-agent/src/core/extensions/types.js";
import {
	DurableInbox,
	INTERCOM_INBOX_ENTRY,
	INTERCOM_INBOX_REPLAY_EVENT,
	type IntercomInboxRecord,
	type IntercomInboxReplayRequest,
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
	const queue = new InboundIdleQueue(() => consumed);
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

interface ResumeDelivery {
	readonly ids: string[];
	readonly triggerTurn: boolean;
}

/**
 * A real Intercom runtime resumed from `branch`, idle, whose shown messages become `intercom_message` cards.
 * With `crashAfterWrites`, the process dies after that many durable writes: later writes never reach `branch`.
 */
async function resumedRuntime(branch: SessionEntry[], crashAfterWrites = Number.POSITIVE_INFINITY) {
	const deliveries: ResumeDelivery[] = [];
	const handlers = new Map<string, Array<(event: object, ctx: ExtensionContext) => void | Promise<void>>>();
	const events = createEventBus();
	let writes = 0;
	/** Count one durable write; false once the process has died, so the write never lands. */
	const write = (): boolean => {
		if (writes >= crashAfterWrites) return false;
		writes += 1;
		return true;
	};
	const dead = new Promise<void>(() => {});
	const show = (
		shownMessages: Array<ShownMessage & { content?: string; details?: object }>,
		options?: { triggerTurn?: boolean },
	) => {
		if (!write()) return dead;
		deliveries.push({
			ids: shownMessages.map((shownMessage) => shownMessage.details?.message?.id ?? "?"),
			triggerTurn: options?.triggerTurn === true,
		});
		for (const shownMessage of shownMessages) {
			branch.push({
				type: "custom_message",
				id: `card-${branch.length}`,
				parentId: null,
				timestamp: new Date(0).toISOString(),
				customType: "intercom_message",
				content: shownMessage.content ?? "",
				display: true,
				details: shownMessage.details,
			});
		}
		return undefined;
	};
	const pi = {
		on(name: string, handler: (event: object, ctx: ExtensionContext) => void | Promise<void>) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		appendEntry(customType: string, data?: object) {
			if (!write()) return dead;
			branch.push({
				type: "custom",
				id: `entry-${branch.length}`,
				parentId: null,
				timestamp: new Date(0).toISOString(),
				customType,
				data,
			});
			return Promise.resolve();
		},
		getSessionName: () => undefined,
		sendMessage: (shownMessage: ShownMessage, options?: { triggerTurn?: boolean }) => show([shownMessage], options),
		sendMessages: show,
		events,
	};
	intercomHeavy(pi as never);
	const ctx = {
		hasUI: true,
		cwd: "/repo",
		isIdle: () => true,
		ui: { notify() {} },
		sessionManager: { getSessionId: () => "resumed-recipient", getBranch: () => branch, getEntries: () => branch },
	} as unknown as ExtensionContext;
	const fire = async (name: string) => {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name, reason: "resume" }, ctx);
	};
	await fire("session_start");
	return {
		deliveries,
		/** Run the replay the lightweight extension requests on resume, with what #3760's decision needs. */
		async replay(peers: readonly SessionInfo[] | undefined, restored: IntercomInboxReplayRequest["restored"] = []) {
			const request: IntercomInboxReplayRequest = { peers, restored };
			events.emit(INTERCOM_INBOX_REPLAY_EVENT, request);
			assert.ok(request.completion, "the loaded runtime answers the replay request");
			const notices = await request.completion;
			// Longer than the idle flush delay, so a queued message has been shown by now.
			await new Promise((resolveFlush) => setTimeout(resolveFlush, INBOUND_FLUSH_SETTLE_MS));
			return notices;
		},
		/** Start the replay and let the process die mid-way: its completion is never awaited. */
		async replayUntilCrash(peers: readonly SessionInfo[]) {
			events.emit(INTERCOM_INBOX_REPLAY_EVENT, { peers, restored: [] } satisfies IntercomInboxReplayRequest);
			await new Promise((resolveFlush) => setTimeout(resolveFlush, INBOUND_FLUSH_SETTLE_MS));
		},
		close: () => fire("session_shutdown"),
	};
}

/** The content of each visible `intercom_message` card on the branch for one message id. */
function cardsFor(branch: readonly SessionEntry[], id: string): string[] {
	return branch.flatMap((entry) =>
		entry.type === "custom_message" &&
		entry.customType === "intercom_message" &&
		(entry.details as { message?: { id?: string } } | undefined)?.message?.id === id
			? [typeof entry.content === "string" ? entry.content : ""]
			: [],
	);
}

const INBOUND_FLUSH_SETTLE_MS = 400;
const gone: SessionInfo = { ...peer, id: "gone-peer", name: "gone-peer" };

test("resume delivers an unshown saved message from a live sender, once, as a normal turn (#3761)", async () => {
	const branch: SessionEntry[] = [inboxEntry({ message: message("from-live"), from: peer, receivedAt: 1 })];
	const first = await resumedRuntime(branch);
	try {
		assert.deepEqual(await first.replay([peer]), []);
		assert.deepEqual(first.deliveries, [{ ids: ["from-live"], triggerTurn: true }]);
	} finally {
		await first.close();
	}
	const second = await resumedRuntime(branch);
	try {
		assert.deepEqual(await second.replay([peer]), []);
		assert.deepEqual(second.deliveries, [], "a message shown on one resume is not shown again on the next");
	} finally {
		await second.close();
	}
});

test("resume does not start a turn for an unshown saved message from a gone sender; it is shown once as history (#3761)", async () => {
	const branch: SessionEntry[] = [
		inboxEntry({ message: message("from-gone"), from: gone, receivedAt: 1 }),
		inboxEntry({ message: message("from-live"), from: peer, receivedAt: 2 }),
	];
	const first = await resumedRuntime(branch);
	try {
		const notices = await first.replay([peer]);
		assert.equal(notices.length, 1);
		assert.match(notices[0] ?? "", /`gone-peer` is gone/);
		assert.match(notices[0] ?? "", /body from-gone/);
		assert.deepEqual(first.deliveries, [
			{ ids: ["from-gone"], triggerTurn: false },
			{ ids: ["from-live"], triggerTurn: true },
		]);
	} finally {
		await first.close();
	}
	assert.deepEqual(unconsumedIntercomInbox(branch), []);
	const second = await resumedRuntime(branch);
	try {
		assert.deepEqual(await second.replay([peer]), [], "the gone sender's message is not reported twice");
		assert.deepEqual(second.deliveries, []);
	} finally {
		await second.close();
	}
	assert.equal(cardsFor(branch, "from-gone").length, 1, "no duplicate card on a second resume");
});

test("resume keeps arrival order in visible history across gone-sender cards and live-sender messages (#3761)", async () => {
	const branch: SessionEntry[] = [
		inboxEntry({ message: message("live-first"), from: peer, receivedAt: 1 }),
		inboxEntry({ message: message("gone-second"), from: gone, receivedAt: 2 }),
		inboxEntry({ message: message("live-third"), from: peer, receivedAt: 3 }),
		inboxEntry({ message: message("gone-fourth"), from: gone, receivedAt: 4 }),
	];
	const runtime = await resumedRuntime(branch);
	try {
		await runtime.replay([peer]);
		const shownOrder = branch.flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === "intercom_message"
				? [(entry.details as { message: { id: string } }).message.id]
				: [],
		);
		assert.deepEqual(shownOrder, ["live-first", "gone-second", "live-third", "gone-fourth"]);
		assert.equal(
			runtime.deliveries.filter((delivery) => delivery.triggerTurn).length,
			1,
			"the live senders start one turn",
		);
	} finally {
		await runtime.close();
	}
	const goneOnly = await resumedRuntime([
		inboxEntry({ message: message("gone-a"), from: gone, receivedAt: 1 }),
		inboxEntry({ message: message("gone-b"), from: gone, receivedAt: 2 }),
	]);
	try {
		await goneOnly.replay([peer]);
		assert.ok(
			goneOnly.deliveries.every((delivery) => !delivery.triggerTurn),
			"gone senders alone start no turn",
		);
	} finally {
		await goneOnly.close();
	}
});

test("a crash right after the first write for a gone sender's saved message still shows it in full, once, on the next resume (#3761)", async () => {
	const branch: SessionEntry[] = [inboxEntry({ message: message("last-words"), from: gone, receivedAt: 1 })];
	const crashed = await resumedRuntime(branch, 1);
	try {
		await crashed.replayUntilCrash([peer]);
	} finally {
		await crashed.close();
	}
	const resumed = await resumedRuntime(branch);
	try {
		await resumed.replay([peer]);
	} finally {
		await resumed.close();
	}
	const again = await resumedRuntime(branch);
	try {
		await again.replay([peer]);
		assert.deepEqual(again.deliveries, []);
	} finally {
		await again.close();
	}
	const cards = cardsFor(branch, "last-words");
	assert.equal(cards.length, 1, "the message is in visible history exactly once");
	assert.match(cards[0] ?? "", /body last-words/);
});

test("a gone sender's saved message longer than 2,000 characters reaches visible history in full (#3761)", async () => {
	const longText = `${"x".repeat(2_500)} end-of-long-message`;
	const attachment = {
		type: "snippet" as const,
		name: "notes.txt",
		content: `${"y".repeat(1_000)} end-of-attachment`,
	};
	const long: Message = { id: "long", timestamp: 1, content: { text: longText, attachments: [attachment] } };
	const branch: SessionEntry[] = [inboxEntry({ message: long, from: gone, receivedAt: 1 })];
	const runtime = await resumedRuntime(branch);
	try {
		await runtime.replay([peer]);
		assert.deepEqual(runtime.deliveries, [{ ids: ["long"], triggerTurn: false }], "history only; no turn starts");
	} finally {
		await runtime.close();
	}
	const cards = cardsFor(branch, "long");
	assert.equal(cards.length, 1);
	assert.ok(cards[0]?.includes(longText), "the full message text is in the card");
	assert.match(cards[0] ?? "", /end-of-attachment/);
});

test("resume with Intercom unreachable defers unshown saved messages without a turn, and the next resume delivers them (#3761)", async () => {
	const branch: SessionEntry[] = [inboxEntry({ message: message("deferred"), from: peer, receivedAt: 1 })];
	const unreachable = await resumedRuntime(branch);
	try {
		const notices = await unreachable.replay(undefined);
		assert.equal(notices.length, 1);
		assert.match(notices[0] ?? "", /could not be reached after the restart/);
		assert.deepEqual(unreachable.deliveries, [], "no message is shown and no turn starts");
	} finally {
		await unreachable.close();
	}
	assert.deepEqual(
		unconsumedIntercomInbox(branch).map((record) => record.message.id),
		["deferred"],
	);
	const reachable = await resumedRuntime(branch);
	try {
		assert.deepEqual(await reachable.replay([peer]), []);
		assert.deepEqual(reachable.deliveries, [{ ids: ["deferred"], triggerTurn: true }]);
	} finally {
		await reachable.close();
	}
});

test("resume defers an unshown saved message from a relaunched subagent that has not reconnected yet (#3761)", async () => {
	const branch: SessionEntry[] = [inboxEntry({ message: message("from-child"), from: gone, receivedAt: 1 })];
	const runtime = await resumedRuntime(branch);
	try {
		const notices = await runtime.replay([], [{ name: "gone-peer", ids: [] }]);
		assert.equal(notices.length, 1);
		assert.match(notices[0] ?? "", /relaunched after the restart but has not reconnected/);
		assert.deepEqual(runtime.deliveries, []);
		assert.equal(unconsumedIntercomInbox(branch).length, 1);
	} finally {
		await runtime.close();
	}
});

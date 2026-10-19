import assert from "node:assert/strict";
import type { SessionEntry } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import type { ExtensionContext } from "../../packages/coding-agent/src/core/extensions/types.js";
import {
	INTERCOM_INBOX_ENTRY,
	INTERCOM_INBOX_REPLAY_EVENT,
	type IntercomInboxRecord,
	type IntercomInboxReplayRequest,
	unconsumedIntercomInbox,
} from "../../packages/intercom/durable-inbox.js";
import {
	INTERCOM_DETACH_REQUEST_EVENT,
	INTERCOM_DETACH_RESPONSE_EVENT,
} from "../../packages/intercom/foreground-detach-handoff.js";
import { InboundMessageAdmission } from "../../packages/intercom/inbound-message-admission.js";
import { createIncomingMessageSender } from "../../packages/intercom/incoming-message-delivery.js";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import type { IntercomExtensionTestOverrides } from "../../packages/intercom/intercom-test-seams.js";
import { SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT } from "../../packages/intercom/intercom-utils.js";
import { registerLateStageMessageRouter } from "../../packages/intercom/late-stage-message-router.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

const session = (id: string): SessionInfo => ({
	id,
	name: id,
	cwd: "/tmp",
	model: "test",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
});
const liveChild = session("live-child");
const otherChild = session("other-child");
const gone = session("gone-peer");

function message(id: string, extra: Partial<Message> = {}): Message {
	return { id, timestamp: 1, content: { text: `body ${id}` }, ...extra };
}

function saved(id: string, from: SessionInfo, receivedAt: number, extra: Partial<Message> = {}): SessionEntry {
	const record: IntercomInboxRecord = { message: message(id, extra), from, receivedAt };
	return {
		type: "custom",
		id: `inbox-${id}`,
		parentId: null,
		timestamp: new Date(receivedAt).toISOString(),
		customType: INTERCOM_INBOX_ENTRY,
		data: record,
	};
}

/** How one write reached the session: starting a turn, queued behind one, or as history that starts nothing. */
type Mode = "turn" | "followUp" | "history";
interface Shown {
	readonly ids: string[];
	readonly mode: Mode;
}
interface ShownMessage {
	content?: string;
	details?: { message?: { id?: string } };
}

// Every reply context any Intercom path hands to the next turn, by message id.
let replyContexts: string[] = [];
beforeEach(() => {
	replyContexts = [];
	const original = ReplyTracker.prototype.queueTurnContext;
	vi.spyOn(ReplyTracker.prototype, "queueTurnContext").mockImplementation(function (this: ReplyTracker, context) {
		replyContexts.push(context.message.id);
		original.call(this, context);
	});
});
afterEach(() => {
	vi.restoreAllMocks();
});

const SETTLE_MS = 400;
const settle = (ms = SETTLE_MS) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A real Intercom runtime resumed from `branch`. Every write becomes an `intercom_message` card on the branch.
 * `batchHost: false` is a host without `sendMessages`, which writes a batch one message at a time.
 */
async function resumedRuntime(branch: SessionEntry[], options: { batchHost?: boolean; failOnce?: string } = {}) {
	const shown: Shown[] = [];
	const handlers = new Map<string, Array<(event: object, ctx: ExtensionContext) => void | Promise<void>>>();
	const events = createEventBus();
	let failOnce = options.failOnce;
	let idle = true;
	let inbound!: Parameters<NonNullable<IntercomExtensionTestOverrides["captureInboundHandler"]>>[0];
	const show = (messages: ShownMessage[], sendOptions?: { triggerTurn?: boolean; deliverAs?: string }) => {
		const ids = messages.map((shownMessage) => shownMessage.details?.message?.id ?? "?");
		if (failOnce !== undefined && ids.includes(failOnce)) {
			failOnce = undefined;
			return Promise.reject(new Error("write failed"));
		}
		const mode: Mode =
			sendOptions?.triggerTurn === true ? "turn" : sendOptions?.deliverAs === "followUp" ? "followUp" : "history";
		shown.push({ ids, mode });
		for (const shownMessage of messages) {
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
		return Promise.resolve();
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
		sendMessage: (shownMessage: ShownMessage, sendOptions?: { triggerTurn?: boolean; deliverAs?: string }) =>
			show([shownMessage], sendOptions),
		...(options.batchHost === false ? {} : { sendMessages: show }),
		events,
	};
	intercomHeavy(pi as never, {
		captureInboundHandler: (handler) => {
			inbound = handler;
		},
	});
	const ctx = {
		hasUI: true,
		cwd: "/repo",
		isIdle: () => idle,
		ui: { notify() {} },
		sessionManager: { getSessionId: () => "resumed-recipient", getBranch: () => branch, getEntries: () => branch },
	} as unknown as ExtensionContext;
	const fire = async (name: string) => {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name, reason: "resume" }, ctx);
	};
	await fire("session_start");
	return {
		shown,
		/** Queue the saved messages a resumed session never showed, without waiting for the idle flush. */
		async replay(peers: readonly SessionInfo[]) {
			const request: IntercomInboxReplayRequest = { peers, restored: [] };
			events.emit(INTERCOM_INBOX_REPLAY_EVENT, request);
			assert.ok(request.completion);
			await request.completion;
		},
		/** A restored task completion for `targets` claims their queued messages ahead of its result. */
		async terminal(targets: readonly SessionInfo[], dispatch = false) {
			events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, {
				runId: "restored-run",
				terminalAt: Date.now(),
				source: "owner-task",
				sourceSessionTargets: targets.map((target) => target.id),
				...(dispatch
					? {
							dispatch: (prefix: ShownMessage[]) =>
								show([...prefix, { details: { message: { id: "terminal-result" } } }], { triggerTurn: true }),
						}
					: {}),
			});
			await settle(10);
		},
		/** A busy recipient's exact foreground child acknowledges a fresh message, which is surfaced at once. */
		async foregroundDetach(from: SessionInfo, arrival: Message) {
			const unsubscribe = events.on(INTERCOM_DETACH_REQUEST_EVENT, (request) => {
				events.emit(INTERCOM_DETACH_RESPONSE_EVENT, { ...(request as object), accepted: true });
			});
			idle = false;
			await inbound(ctx, from, arrival);
			await vi.waitFor(() => assert.ok(shown.some((write) => write.ids.includes(arrival.id))));
			unsubscribe();
			idle = true;
		},
		close: () => fire("session_shutdown"),
	};
}

type Runtime = Awaited<ReturnType<typeof resumedRuntime>>;

test("a gone sender's replayed card left alone after a restored task completion takes the live child's message starts no turn and gives no reply context (#3761)", async () => {
	const branch = [saved("live-first", liveChild, 1), saved("gone-second", gone, 2, { expectsReply: true })];
	const runtime = await resumedRuntime(branch);
	try {
		await runtime.replay([liveChild]);
		await runtime.terminal([liveChild]);
		await settle();
		assert.deepEqual(runtime.shown, [
			{ ids: ["live-first"], mode: "history" },
			{ ids: ["gone-second"], mode: "history" },
		]);
		assert.deepEqual(replyContexts, [], "a history-only card never becomes the turn's reply target");
		const card = branch.find(
			(entry) =>
				entry.type === "custom_message" &&
				(entry.details as { message?: { id?: string } }).message?.id === "gone-second",
		);
		assert.ok(card?.type === "custom_message");
		assert.doesNotMatch(String(card.content), /To reply/);
	} finally {
		await runtime.close();
	}
});

// Arrival order on the branch for every table row: live, gone, other live, gone.
const mixed = () => [
	saved("live-a", liveChild, 1),
	saved("gone-b", gone, 2),
	saved("live-c", otherChild, 3),
	saved("gone-d", gone, 4),
];
const peers = [liveChild, otherChild];

interface ConsumerCase {
	readonly consumer: string;
	readonly branch?: () => SessionEntry[];
	readonly batchHost?: boolean;
	readonly failOnce?: string;
	readonly between?: (runtime: Runtime) => Promise<void>;
	readonly shown: Shown[];
	readonly replyContexts: string[];
	/** After a shutdown before the flush, what the next resume of the same branch shows. */
	readonly nextResume?: { shown: Shown[]; replyContexts: string[] };
}

const consumers: ConsumerCase[] = [
	{
		consumer: "replay on resume writes a gone card with no live message ahead of it at once",
		branch: () => [saved("gone-first", gone, 1), saved("live-a", liveChild, 2), saved("gone-b", gone, 3)],
		shown: [
			{ ids: ["gone-first"], mode: "history" },
			{ ids: ["live-a", "gone-b"], mode: "turn" },
		],
		replyContexts: ["live-a"],
	},
	{
		consumer: "idle flush batches the queue behind the first live message",
		shown: [{ ids: ["live-a", "gone-b", "live-c", "gone-d"], mode: "turn" }],
		replyContexts: ["live-a"],
	},
	{
		consumer: "idle flush on a one-at-a-time host",
		batchHost: false,
		shown: [
			{ ids: ["live-a"], mode: "turn" },
			{ ids: ["gone-b"], mode: "followUp" },
			{ ids: ["live-c"], mode: "followUp" },
			{ ids: ["gone-d"], mode: "followUp" },
		],
		replyContexts: ["live-a"],
	},
	{
		consumer: "terminal barrier takes the first live message",
		between: (runtime) => runtime.terminal([liveChild]),
		shown: [
			{ ids: ["live-a"], mode: "history" },
			{ ids: ["gone-b", "live-c", "gone-d"], mode: "turn" },
		],
		replyContexts: ["live-c"],
	},
	{
		consumer: "terminal barrier takes the first live message on a one-at-a-time host",
		batchHost: false,
		between: (runtime) => runtime.terminal([liveChild]),
		shown: [
			{ ids: ["live-a"], mode: "history" },
			{ ids: ["gone-b"], mode: "history" },
			{ ids: ["live-c"], mode: "turn" },
			{ ids: ["gone-d"], mode: "followUp" },
		],
		replyContexts: ["live-c"],
	},
	{
		consumer: "terminal barriers take every live message",
		between: async (runtime) => {
			await runtime.terminal([liveChild]);
			await runtime.terminal([otherChild]);
		},
		shown: [
			{ ids: ["live-a"], mode: "history" },
			{ ids: ["live-c"], mode: "history" },
			{ ids: ["gone-b", "gone-d"], mode: "history" },
		],
		replyContexts: [],
	},
	{
		consumer: "terminal barrier rolls a failed prelude back into its queue position",
		failOnce: "live-c",
		between: (runtime) => runtime.terminal([liveChild, otherChild]),
		shown: [
			{ ids: ["live-a"], mode: "history" },
			{ ids: ["gone-b", "live-c", "gone-d"], mode: "turn" },
		],
		replyContexts: ["live-c"],
	},
	{
		consumer: "terminal barrier dispatch carries a gone sender's cards ahead of its result",
		between: (runtime) => runtime.terminal([gone], true),
		shown: [
			{ ids: ["gone-b", "gone-d", "terminal-result"], mode: "turn" },
			{ ids: ["live-a", "live-c"], mode: "turn" },
		],
		replyContexts: ["live-a"],
	},
	{
		consumer: "foreground-detach handoff surfaces only its own fresh message",
		between: (runtime) => runtime.foregroundDetach(liveChild, message("fresh")),
		shown: [
			{ ids: ["fresh"], mode: "turn" },
			{ ids: ["live-a", "gone-b", "live-c", "gone-d"], mode: "turn" },
		],
		replyContexts: ["fresh", "live-a"],
	},
	{
		consumer: "shutdown drains the queue before the idle flush",
		between: (runtime) => runtime.close(),
		shown: [],
		replyContexts: [],
		nextResume: {
			shown: [{ ids: ["live-a", "gone-b", "live-c", "gone-d"], mode: "turn" }],
			replyContexts: ["live-a"],
		},
	},
];

test.each(consumers)(
	"$consumer: a batch starts a turn only with a live entry, takes reply context only from one, and keeps history in arrival order (#3761)",
	async (row) => {
		const branch = (row.branch ?? mixed)();
		const runtime = await resumedRuntime(branch, { batchHost: row.batchHost, failOnce: row.failOnce });
		try {
			await runtime.replay(peers);
			await row.between?.(runtime);
			await settle(row.consumer.startsWith("foreground") ? 3 * SETTLE_MS : SETTLE_MS);
			assert.deepEqual(runtime.shown, row.shown);
			assert.deepEqual(replyContexts, row.replyContexts);
		} finally {
			await runtime.close();
		}
		if (!row.nextResume) {
			assert.deepEqual(unconsumedIntercomInbox(branch), [], "every saved message reached the session once");
			return;
		}
		replyContexts = [];
		const next = await resumedRuntime(branch, { batchHost: row.batchHost });
		try {
			await next.replay(peers);
			await settle();
			assert.deepEqual(next.shown, row.nextResume.shown);
			assert.deepEqual(replyContexts, row.nextResume.replyContexts);
		} finally {
			await next.close();
		}
	},
);

test("a history-only card reaching a delivery chokepoint on its own starts no turn and gives no reply context (#3761)", async () => {
	const historyCard = {
		from: gone,
		message: message("gone-card"),
		bodyText: "body gone-card",
		historyOnly: true as const,
	};
	const liveCard = { from: liveChild, message: message("live-card"), bodyText: "body live-card" };

	// The single-message sender: a "trigger" request for a history-only card is written without a turn.
	const sends: Array<{ id: string; triggerTurn: boolean }> = [];
	const send = createIncomingMessageSender({
		pi: {
			sendMessage: ((shownMessage: { details: { message: Message } }, options?: { triggerTurn?: boolean }) => {
				sends.push({ id: shownMessage.details.message.id, triggerTurn: options?.triggerTurn === true });
			}) as never,
		},
		currentGeneration: () => 0,
		canDeliver: () => true,
		queueTurnContext: (context) => replyContexts.push(context.message.id),
	});
	await send(historyCard, "trigger");
	await send(liveCard, "trigger");
	assert.deepEqual(sends, [
		{ id: "gone-card", triggerTurn: false },
		{ id: "live-card", triggerTurn: true },
	]);
	assert.deepEqual(replyContexts, ["live-card"]);

	// The closed-stage batch router: reply context comes from the live card, never the history card ahead of it,
	// and a batch of history cards alone starts no turn.
	replyContexts = [];
	const events = createEventBus();
	const recorded: string[] = [];
	const tracker = new ReplyTracker();
	const record = tracker.recordIncomingMessage.bind(tracker);
	tracker.recordIncomingMessage = (from, incoming, receivedAt) => {
		recorded.push(incoming.id);
		return record(from, incoming, receivedAt);
	};
	const batches: Array<{ ids: string[]; triggerTurn: boolean }> = [];
	registerLateStageMessageRouter(
		{
			events,
			sendMessages: (messages: Array<{ details: { message: Message } }>, options?: { triggerTurn?: boolean }) => {
				batches.push({
					ids: messages.map((shownMessage) => shownMessage.details.message.id),
					triggerTurn: options?.triggerTurn === true,
				});
			},
		} as never,
		new InboundMessageAdmission(),
		() => tracker,
	);
	const toMessage = (entry: typeof liveCard) => ({
		customType: "intercom_message",
		content: entry.bodyText,
		display: true,
		details: entry,
	});
	const route = async (messages: object[]) => {
		const event = { handled: false, batch: true, messages, options: { triggerTurn: true } } as {
			handled: boolean;
			batch: boolean;
			messages: object[];
			options: object;
			completion?: Promise<void>;
		};
		events.emit("atomic:workflow-stage-late-message", event);
		await event.completion;
	};
	await route([toMessage(historyCard), toMessage(liveCard)]);
	await route([toMessage({ ...historyCard, message: message("gone-alone") })]);
	assert.deepEqual(batches, [
		{ ids: ["gone-card", "live-card"], triggerTurn: true },
		{ ids: ["gone-alone"], triggerTurn: false },
	]);
	assert.deepEqual(recorded, ["live-card"]);
	assert.deepEqual(replyContexts, ["live-card"]);
});

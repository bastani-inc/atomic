import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { test, vi } from "vitest";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import type { InboundMessageEntry } from "../../packages/intercom/intercom-utils.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

type Inbound = (
	ctx: ExtensionContext,
	from: SessionInfo,
	message: Message,
	channel?: "supervisor",
) => void | Promise<void>;

function session(id: string): SessionInfo {
	return { id, name: id, cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1 };
}

/** A parent session whose idle and task-wait state each test sets, recording the order messages reach its context. */
function parent() {
	const lifecycle = new Map<string, Array<(event: object, ctx: ExtensionContext) => void | Promise<void>>>();
	const admitted: Array<{ content: string; details: InboundMessageEntry }> = [];
	const eventHandlers = new Map<string, Array<(event: object) => unknown>>();
	const state = { idle: true, waiting: false };
	let inbound!: Inbound;
	const pi = {
		on(name: string, handler: (event: object, ctx: ExtensionContext) => void | Promise<void>) {
			lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		async appendEntry() {},
		getSessionName: () => undefined,
		registerMessageRenderer() {},
		async sendMessage(message: { content: string; details: InboundMessageEntry }) {
			admitted.push(message);
		},
		async sendMessages(messages: Array<{ content: string; details: InboundMessageEntry }>) {
			admitted.push(...messages);
		},
		events: {
			on(name: string, handler: (event: object) => unknown) {
				eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
				return () => {};
			},
			emit(name: string, event: object) {
				for (const handler of eventHandlers.get(name) ?? []) handler(event);
			},
		},
	};
	intercomHeavy(pi as never, {
		captureInboundHandler: (handler) => {
			inbound = handler;
		},
	});
	const context = {
		hasUI: true,
		cwd: process.cwd(),
		model: { id: "test" },
		isIdle: () => state.idle,
		getAgentTaskHost: () => ({ hasActiveTaskWaits: state.waiting }),
		ui: { notify() {} },
		sessionManager: { getSessionId: () => "parent-session", getBranch: () => [] },
	} as unknown as ExtensionContext;
	return {
		state,
		admittedIds: () => admitted.map((entry) => entry.details.message.id),
		async emit(name: string) {
			for (const handler of lifecycle.get(name) ?? []) await handler({ type: name }, context);
		},
		deliver(from: SessionInfo, id: string, channel?: "supervisor") {
			return inbound(context, from, { id, timestamp: Date.now(), content: { text: id } }, channel);
		},
	};
}

const child = session("worker");
const peer = session("peer");

test("a later message from a sender is never admitted before its earlier one that waited for idle", async () => {
	const current = parent();
	await current.emit("session_start");
	try {
		// Busy with no task wait: the first message waits for the parent to go idle.
		current.state.idle = false;
		await current.deliver(child, "report");
		await current.deliver(peer, "unrelated");
		assert.deepEqual(current.admittedIds(), []);
		// The parent now waits on a task, so the sender's next message is admitted at once; its earlier one goes first.
		current.state.waiting = true;
		await current.deliver(child, "progress", "supervisor");
		assert.deepEqual(current.admittedIds(), ["report", "progress"]);
		// The other sender's message keeps its place until the parent is idle, and nothing is shown twice.
		current.state.waiting = false;
		current.state.idle = true;
		await current.emit("agent_end");
		await vi.waitFor(() => assert.deepEqual(current.admittedIds(), ["report", "progress", "unrelated"]));
	} finally {
		await current.emit("session_shutdown");
	}
});

test("a message that arrives just after the parent went idle does not overtake the sender's queued one", async () => {
	const current = parent();
	await current.emit("session_start");
	try {
		current.state.idle = false;
		await current.deliver(child, "first");
		assert.deepEqual(current.admittedIds(), []);
		// Idle again, before the queued message's flush runs: the next one from the same sender starts the turn.
		current.state.idle = true;
		await current.deliver(child, "second");
		assert.deepEqual(current.admittedIds(), ["first", "second"]);
		await current.emit("agent_end");
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
		assert.deepEqual(current.admittedIds(), ["first", "second"]);
	} finally {
		await current.emit("session_shutdown");
	}
});

test("messages from one sender admitted at once together never overtake its queued ones or each other", async () => {
	const current = parent();
	await current.emit("session_start");
	try {
		current.state.idle = false;
		await current.deliver(child, "first");
		await current.deliver(child, "second");
		current.state.idle = true;
		await Promise.all([current.deliver(child, "third"), current.deliver(child, "fourth")]);
		assert.deepEqual(current.admittedIds(), ["first", "second", "third", "fourth"]);
	} finally {
		await current.emit("session_shutdown");
	}
});

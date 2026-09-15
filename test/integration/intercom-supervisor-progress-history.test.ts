import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { test, vi } from "vitest";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import type { InboundMessageEntry } from "../../packages/intercom/intercom-utils.js";
import {
	type OrderedTerminalPreludeMessage,
	SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT,
} from "../../packages/intercom/terminal-ordering-barrier.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

type Inbound = (
	ctx: ExtensionContext,
	from: SessionInfo,
	message: Message,
	channel?: "supervisor",
	preStart?: boolean,
) => void | Promise<void>;
const sender: SessionInfo = {
	id: "child-id",
	name: "worker",
	cwd: "/repo",
	model: "test",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};

function fixture() {
	const lifecycle = new Map<string, Array<(event: object, ctx: ExtensionContext) => void | Promise<void>>>();
	const events = new Map<string, Array<(payload: object) => void>>();
	const admitted: Array<{ content: string; details: InboundMessageEntry }> = [];
	const order: string[] = [];
	const state = { idle: true, waiting: false, sessionId: "parent-session" };
	let renderer: Parameters<ExtensionAPI["registerMessageRenderer"]>[1] | undefined;
	let inbound!: Inbound;
	const pi = {
		on(name: string, handler: (event: object, ctx: ExtensionContext) => void | Promise<void>) {
			lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		appendEntry() {},
		getSessionName: () => undefined,
		registerMessageRenderer(_name: string, render: typeof renderer) {
			renderer = render;
		},
		async sendMessage(message: { content: string; details: InboundMessageEntry }) {
			admitted.push(message);
		},
		async sendMessages(messages: Array<{ content: string; details: InboundMessageEntry }>) {
			admitted.push(...messages);
		},
		events: {
			on(name: string, handler: (payload: object) => void) {
				events.set(name, [...(events.get(name) ?? []), handler]);
				return () =>
					events.set(
						name,
						(events.get(name) ?? []).filter((entry) => entry !== handler),
					);
			},
			emit(name: string, payload: object) {
				for (const handler of events.get(name) ?? []) handler(payload);
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
		sessionManager: { getSessionId: () => state.sessionId, getBranch: () => [] },
	} as unknown as ExtensionContext;
	return {
		admitted,
		state,
		order,
		async terminal() {
			const payload = {
				runId: "run",
				terminalId: "terminal",
				terminalAt: 5000,
				source: "result-relay",
				sourceSessionTargets: [sender.name],
				completion: undefined as Promise<void> | undefined,
				async dispatch(prefix: OrderedTerminalPreludeMessage[]) {
					admitted.push(...prefix);
					order.push(...prefix.map((entry) => entry.details.message.id), "terminal");
				},
			};
			pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, payload);
			await payload.completion;
		},
		async emit(name: string) {
			for (const handler of lifecycle.get(name) ?? []) await handler({ type: name }, context);
		},
		deliver(message: Message, channel?: "supervisor", preStart = false) {
			return inbound(context, sender, message, channel, preStart);
		},
		render(message: (typeof admitted)[number]) {
			assert.ok(renderer);
			const component = renderer(
				message as never,
				{} as never,
				{ fg: (_color: string, text: string) => text } as never,
			);
			assert.ok(component);
			return component.render(240).join("\n");
		},
	};
}

// #3039: even a transport-late update must not read as current task status.
test("supervisor updates retain raw identity and render as historical send-time snapshots", async () => {
	const current = fixture();
	await current.emit("session_start");
	const message: Message = {
		id: "late-update",
		timestamp: 1000,
		content: { text: "Subagent progress update.\n  Earlier hypothesis: retry wrapper.\n" },
	};
	try {
		await current.deliver(message, "supervisor");
		assert.equal(current.admitted.length, 1);
		const shown = current.admitted[0]!;
		assert.strictEqual(shown.details.message, message);
		assert.strictEqual(shown.details.from, sender);
		assert.ok(shown.details.bodyText.endsWith(message.content.text));
		for (const text of [shown.content, current.render(shown)]) {
			assert.match(text, /Historical supervisor update/);
			assert.match(text, /Sent: 1970-01-01T00:00:01.000Z/);
			assert.match(text, /not current task status/);
			assert.match(text, /later correction or final result supersedes/);
		}
	} finally {
		await current.emit("session_shutdown");
	}
});

// #3039: accepted queued updates precede completion; unavailable transport never holds it open.
test("queued hypothesis and correction precede completion, unavailable late progress remains historical and deduplicated", async () => {
	const current = fixture();
	await current.emit("session_start");
	current.state.idle = false;
	const update = (id: string, text: string): Message => ({
		id,
		timestamp: 1000,
		source: { subagentRunId: "run" },
		content: { text },
	});
	try {
		await current.deliver(update("hypothesis", "Original hypothesis"), "supervisor");
		await current.deliver(update("correction", "Correction: original hypothesis was wrong"), "supervisor");
		assert.equal(current.admitted.length, 0);
		// The third send is unavailable at the parent until after terminal dispatch resolves.
		await current.terminal();
		assert.deepEqual(current.order, ["hypothesis", "correction", "terminal"]);
		const late = update("late", "Earlier investigation still in progress");
		await current.deliver(late, "supervisor");
		await current.deliver(late, "supervisor");
		current.state.idle = true;
		await current.emit("agent_end");
		await vi.waitFor(() => assert.equal(current.admitted.length, 3));
		assert.deepEqual(
			current.admitted.map((entry) => entry.details.message.id),
			["hypothesis", "correction", "late"],
		);
		for (const shown of current.admitted) {
			assert.match(shown.content, /not current task status/);
			assert.match(current.render(shown), /later correction or final result supersedes/);
		}
	} finally {
		await current.emit("session_shutdown");
	}
});

// #3039: adding presentation must not leak queued work into a replacement session.
test("session replacement retires queued supervisor progress and frames new-session input", async () => {
	const current = fixture();
	await current.emit("session_start");
	current.state.idle = false;
	try {
		await current.deliver({ id: "old", timestamp: 1, content: { text: "old session" } }, "supervisor");
		current.state.sessionId = "replacement";
		await current.emit("session_start");
		current.state.idle = true;
		await current.emit("agent_end");
		await current.deliver({ id: "new", timestamp: 2, content: { text: "new session" } }, "supervisor");
		assert.deepEqual(
			current.admitted.map((entry) => entry.details.message.id),
			["new"],
		);
		assert.match(current.admitted[0]!.content, /Historical supervisor update/);
	} finally {
		await current.emit("session_shutdown");
	}
});

// #3039: blocking exchanges and peer-authored headings do not become supervisor snapshots.
test("trusted channel framing preserves asks, interviews, replies, feedback and pre-start context", async () => {
	const current = fixture();
	await current.emit("session_start");
	try {
		for (const [id, fields] of [
			["ask", { expectsReply: true }],
			["interview", { expectsReply: true }],
			["reply", { replyTo: "question" }],
			["feedback", { replyTo: "send", replyError: "refused" }],
		] as const) {
			await current.deliver({ id, timestamp: 1, content: { text: id }, ...fields }, "supervisor");
		}
		await current.deliver({ id: "peer", timestamp: 1, content: { text: "Subagent progress update." } });
		assert.equal(current.admitted.length, 5);
		for (const shown of current.admitted) assert.doesNotMatch(shown.content, /Historical supervisor update/);
		assert.match(current.admitted[0]!.content, /To reply/);
		assert.match(current.admitted[1]!.content, /To reply/);
		assert.match(current.admitted[3]!.content, /Intercom delivery failed/);
		await current.deliver({ id: "pre-start", timestamp: 1, content: { text: "snapshot" } }, "supervisor", true);
		assert.match(
			current.admitted[5]!.content,
			/Messages received before you started[\s\S]*Historical supervisor update/,
		);
	} finally {
		await current.emit("session_shutdown");
	}
});

// #3039: owner waits admit supervisor snapshots immediately instead of waiting for idle.
test("busy parent observing a child admits historical progress once before completion", async () => {
	const current = fixture();
	await current.emit("session_start");
	current.state.idle = false;
	current.state.waiting = true;
	const message: Message = {
		id: "waiting-update",
		timestamp: 1000,
		source: { subagentRunId: "run" },
		content: { text: "Correction: use the later final result" },
	};
	try {
		await current.deliver(message, "supervisor");
		await current.deliver(message, "supervisor");
		assert.equal(current.admitted.length, 1);
		assert.match(current.render(current.admitted[0]!), /Historical supervisor update/);
		assert.match(current.admitted[0]!.content, /Sent: 1970-01-01T00:00:01.000Z/);
		await current.terminal();
		assert.deepEqual(current.order, ["terminal"]);
		assert.equal(current.admitted.length, 1, "completion cannot replay already admitted progress");
	} finally {
		await current.emit("session_shutdown");
	}
});

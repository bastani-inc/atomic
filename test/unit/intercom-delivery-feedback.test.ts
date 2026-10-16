import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import type { ExtensionContext, SendMessageOptions } from "../../packages/coding-agent/src/core/extensions/types.js";
import { flushTaskCompletionMessages } from "../../packages/coding-agent/src/core/tasks/completion-ordering.js";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import type { IntercomExtensionTestOverrides } from "../../packages/intercom/intercom-test-seams.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

const sender: SessionInfo = {
	id: "child-session",
	name: "subagent-debugger-refusal-1",
	cwd: "/repo",
	model: "test",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};
const refusal: Message = {
	id: "busy-refusal",
	timestamp: 1000,
	replyTo: "parent-amendment",
	replyError: "Message not accepted: recipient was busy in non-interactive mode. Its task was not interrupted.",
	content: { text: "Message not accepted: recipient was busy in non-interactive mode. Its task was not interrupted." },
};

afterEach(() => vi.useRealTimers());

async function fixture(closedStage = false) {
	let idle = false;
	let rejectDelivery = false;
	let sessionId = "parent-feedback-test";
	let deliveryGate: Promise<void> | undefined;
	const handlers = new Map<string, Array<(event: object, ctx: ExtensionContext) => void | Promise<void>>>();
	let inbound!: Parameters<NonNullable<IntercomExtensionTestOverrides["captureInboundHandler"]>>[0];
	const sent: Array<{ content: string; options?: SendMessageOptions }> = [];
	const send = (message: { content: string }, options?: SendMessageOptions) => {
		if (rejectDelivery) throw new Error("display admission failed");
		sent.push({ content: message.content, options });
		return deliveryGate;
	};
	const pi = {
		on(name: string, handler: (event: object, ctx: ExtensionContext) => void | Promise<void>) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry() {},
		getSessionName: () => undefined,
		sendMessage: send,
		sendMessages: (messages: Array<{ content: string }>, options?: SendMessageOptions) => {
			for (const message of messages) send(message, options);
		},
		events: createEventBus(),
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
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
		...(closedStage
			? {
					orchestrationContext: {
						kind: "workflow-stage",
						messageAdmission: {
							isOpen: () => false,
							boundary: { ownsSubagentRun: (runId: string) => runId === "owned-run" },
						},
					},
				}
			: {}),
	} as unknown as ExtensionContext;
	const fire = async (name: string) => {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx);
	};
	await fire("session_start");
	return {
		sent,
		fire,
		events: pi.events,
		setSessionId(value: string) {
			sessionId = value;
		},
		setDeliveryGate(value: Promise<void> | undefined) {
			deliveryGate = value;
		},
		setIdle(value: boolean) {
			idle = value;
		},
		setReject(value: boolean) {
			rejectDelivery = value;
		},
		deliver: (message: Message) => inbound(ctx, sender, message),
		close: () => fire("session_shutdown"),
	};
}

test("a busy parent's correlated delivery refusal appears immediately, never as a later triggered turn", async () => {
	vi.useFakeTimers();
	const current = await fixture();
	try {
		const delivered = current.deliver(refusal);
		await vi.advanceTimersByTimeAsync(60);
		await delivered;
		assert.equal(current.sent.length, 1, "refusal must not wait in the busy parent's idle queue");
		assert.match(current.sent[0]!.content, /Intercom delivery failed/);
		assert.match(current.sent[0]!.content, /1970-01-01T00:00:01.000Z/);
		assert.notEqual(current.sent[0]!.options?.triggerTurn, true);
		assert.equal(current.sent[0]!.options?.persistWhenStreaming, true);
		await current.deliver(refusal);
		current.setIdle(true);
		await current.fire("agent_end");
		await vi.advanceTimersByTimeAsync(2000);
		assert.equal(current.sent.length, 1, "idle flush and duplicate receipt must not replay stale feedback");
	} finally {
		await current.close();
	}
});

test("ordinary child messages retain their FIFO idle delivery rather than being discarded as status", async () => {
	vi.useFakeTimers();
	const current = await fixture();
	try {
		for (const id of ["first", "second"]) {
			const pending = current.deliver({ id, timestamp: 1000, content: { text: id } });
			await vi.advanceTimersByTimeAsync(60);
			await pending;
		}
		assert.equal(current.sent.length, 0);
		current.setIdle(true);
		await current.fire("agent_end");
		await vi.advanceTimersByTimeAsync(2000);
		assert.equal(current.sent.length, 2);
		assert.match(current.sent[0]!.content, /first/);
		assert.match(current.sent[1]!.content, /second/);
	} finally {
		await current.close();
	}
});

test("feedback retries transient display admission with one stable identity", async () => {
	vi.useFakeTimers();
	const current = await fixture();
	try {
		current.setReject(true);
		const pending = current.deliver(refusal);
		await vi.advanceTimersByTimeAsync(250);
		assert.equal(current.sent.length, 0);
		current.setReject(false);
		await vi.advanceTimersByTimeAsync(100);
		await pending;
		assert.equal(current.sent.length, 1);
		assert.equal(current.sent[0]!.options?.stageAdmissionKey, `intercom:${refusal.id}`);
		await current.deliver(refusal);
		assert.equal(current.sent.length, 1);
	} finally {
		await current.close();
	}
});

test("idle delivery feedback does not start a new agent turn", async () => {
	const current = await fixture();
	try {
		current.setIdle(true);
		await current.deliver(refusal);
		assert.equal(current.sent.length, 1);
		assert.notEqual(current.sent[0]!.options?.triggerTurn, true);
	} finally {
		await current.close();
	}
});

test("completion prelude cannot continue or roll back into a replacement parent session", async () => {
	vi.useFakeTimers();
	const current = await fixture();
	const gate = Promise.withResolvers<void>();
	try {
		for (const id of ["old-first", "old-second"]) {
			const pending = current.deliver({ id, timestamp: 1, content: { text: id } });
			await vi.advanceTimersByTimeAsync(60);
			await pending;
		}
		current.setDeliveryGate(gate.promise);
		const ordering = flushTaskCompletionMessages(
			current.events,
			{ runId: "child-run", intercomTarget: sender.name! },
			"old-completion",
		);
		const rejected = assert.rejects(ordering, /retired/);
		assert.equal(current.sent.length, 1);
		current.setSessionId("replacement-parent");
		await current.fire("session_start");
		current.setDeliveryGate(undefined);
		const fresh = current.deliver({ id: "fresh", timestamp: 2, content: { text: "new-owner-message" } });
		await vi.advanceTimersByTimeAsync(60);
		await fresh;
		gate.resolve();
		await rejected;
		current.setIdle(true);
		await current.fire("agent_end");
		await vi.advanceTimersByTimeAsync(1000);
		assert.equal(current.sent.length, 2);
		assert.match(current.sent[0]!.content, /old-first/);
		assert.match(current.sent[1]!.content, /new-owner-message/);
	} finally {
		gate.resolve();
		await current.close();
	}
});

test("closed stages keep non-owned refusals as feedback and suppress their own retired child traffic", async () => {
	const current = await fixture(true);
	try {
		await current.deliver({ ...refusal, id: "owned-refusal", source: { subagentRunId: "owned-run" } });
		assert.equal(current.sent.length, 0);
		await current.deliver({ ...refusal, source: { subagentRunId: "external-run" } });
		assert.equal(current.sent.length, 1);
		assert.match(current.sent[0]!.content, /Intercom delivery failed/);
		assert.match(current.sent[0]!.content, /1970-01-01T00:00:01.000Z/);
		assert.notEqual(current.sent[0]!.options?.triggerTurn, true);
		await current.deliver({ ...refusal, source: { subagentRunId: "external-run" } });
		assert.equal(current.sent.length, 1);
	} finally {
		await current.close();
	}
});

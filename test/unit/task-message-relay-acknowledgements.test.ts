import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { SUBAGENT_CONTROL_INTERCOM_EVENT } from "../../packages/intercom/intercom-utils.js";
import { registerSubagentRelay } from "../../packages/intercom/subagent-relay.js";
import { sendTaskTranscriptMessage } from "../../packages/subagents/src/intercom/task-message.js";
import {
	SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
} from "../../packages/subagents/src/shared/types.js";

afterEach(() => vi.useRealTimers());

test("acknowledgements resolve once and remove their listener (#4521)", async () => {
	let listener: ((data: unknown) => void) | undefined;
	let unsubscribes = 0;
	const events = {
		on: (_name: string, handler: (data: unknown) => void) => {
			listener = handler;
			return () => {
				unsubscribes++;
			};
		},
		emit: (_name: string, data: unknown) => {
			const { requestId } = data as { requestId: string };
			listener?.({ requestId, delivered: true });
			listener?.({ requestId, delivered: false });
		},
	};
	assert.deepEqual(await sendTaskTranscriptMessage(events, "child", "hello"), { delivered: true });
	assert.equal(unsubscribes, 1);
});

test("malformed acknowledgements are ignored until the matching delivery (#4521)", async () => {
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const events = createEventBus();
		events.on(SUBAGENT_RESULT_INTERCOM_EVENT, (data) => {
			const { requestId } = data as { requestId: string };
			events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, null);
			events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, undefined);
			events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, "not an acknowledgement");
			events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId, delivered: true });
		});
		assert.deepEqual(await sendTaskTranscriptMessage(events, "child", "hello"), { delivered: true });
		assert.equal(logged.mock.calls.length, 0);
	} finally {
		logged.mockRestore();
	}
});

test("a timeout uses the default monotonic clock and releases its listener (#4521)", async () => {
	vi.useFakeTimers();
	let unsubscribes = 0;
	const events = {
		on: () => () => {
			unsubscribes++;
		},
		emit: () => {},
	};
	const result = sendTaskTranscriptMessage(events, "child", "hello", { timeoutMs: 20 });
	await vi.advanceTimersByTimeAsync(20);
	assert.deepEqual(await result, { delivered: false, reason: "unconfirmed", timeoutMs: 20, elapsedMs: 20 });
	assert.equal(unsubscribes, 1);
});

test("a synchronous event bus failure rejects and releases its listener (#4521)", async () => {
	let unsubscribes = 0;
	const failure = new Error("closed");
	const events = {
		on: () => () => {
			unsubscribes++;
		},
		emit: () => {
			throw failure;
		},
	};
	await assert.rejects(sendTaskTranscriptMessage(events, "child", "hello"), (error) => error === failure);
	assert.equal(unsubscribes, 1);
});

test("control messages deliver locally without a result acknowledgement (#4521)", async () => {
	const events = createEventBus();
	const deliveries: unknown[] = [];
	const messages: string[] = [];
	events.on(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, (data) => deliveries.push(data));
	const context = { cwd: "/tmp" };
	registerSubagentRelay(
		{ events, appendEntry: async () => {} } as never,
		{
			runtimeGeneration: () => 1,
			runtimeStarted: () => true,
			runtimeContext: () => context,
			getLiveContext: () => context,
			currentSessionTargetMatches: () => true,
			sendIncomingMessage: (entry: { bodyText: string }) => messages.push(entry.bodyText),
			ensureConnected: async () => {
				throw new Error("unexpected broker connection");
			},
			resolveSessionTarget: async () => "target",
		} as never,
	);
	events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, { to: "target", message: "attention", requestId: "request-1" });
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	assert.equal(messages.length, 1);
	assert.deepEqual(deliveries, []);
});

test("a timer without unref still bounds acknowledgement waiting (#4521)", async () => {
	let fire: (() => void) | undefined;
	vi.stubGlobal("setTimeout", (callback: () => void) => {
		fire = callback;
		return 123;
	});
	vi.stubGlobal("clearTimeout", () => {});
	try {
		const result = sendTaskTranscriptMessage({ on: () => () => {}, emit: () => {} }, "child", "hello", {
			timeoutMs: 10,
			now: () => 0,
		});
		assert.ok(fire);
		fire();
		assert.deepEqual(await result, { delivered: false, reason: "unconfirmed", timeoutMs: 10, elapsedMs: 0 });
	} finally {
		vi.unstubAllGlobals();
	}
});

test("a synchronous acknowledgement during subscription is accepted (#4521)", async () => {
	const uuid = "00000000-0000-4000-8000-000000000000";
	vi.resetModules();
	vi.doMock("node:crypto", async (original) => ({
		...(await original<typeof import("node:crypto")>()),
		randomUUID: () => uuid,
	}));
	vi.useFakeTimers();
	try {
		const events = {
			on: (_name: string, handler: (data: unknown) => void) => {
				handler({ requestId: uuid, delivered: true });
				return () => {};
			},
			emit: () => {},
		};
		const { sendTaskTranscriptMessage: send } = await import("../../packages/subagents/src/intercom/task-message.js");
		assert.deepEqual(await send(events, "child", "hello"), { delivered: true });
	} finally {
		vi.doUnmock("node:crypto");
	}
});

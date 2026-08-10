import assert from "node:assert/strict";
import { test } from "vitest";
import { deliverLocalCompletionNotification } from "../../packages/subagents/src/runs/background/completion-notification.js";
import registerSubagentNotify from "../../packages/subagents/src/runs/background/notify.js";

function createHarness() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	let sends = 0;
	const pi = {
		events: {
			on(event: string, handler: (data: unknown) => void) {
				const set = listeners.get(event) ?? new Set();
				set.add(handler);
				listeners.set(event, set);
				return () => set.delete(handler);
			},
			emit(event: string, payload: unknown) {
				for (const handler of listeners.get(event) ?? []) handler(payload);
			},
		},
		sendMessage() {
			sends += 1;
			if (sends === 1) throw new Error("injected notification failure");
		},
	};
	return { pi, sends: () => sends };
}

test("local completion acknowledgement retries failures and dedupes successful request ids", async () => {
	const harness = createHarness();
	const unregister = registerSubagentNotify(harness.pi as never);
	const payload = { id: "notify-run", agent: "worker", success: true, summary: "done" };
	assert.equal(await deliverLocalCompletionNotification(harness.pi.events, payload, "stable-notify"), false);
	assert.equal(await deliverLocalCompletionNotification(harness.pi.events, payload, "stable-notify"), true);
	assert.equal(await deliverLocalCompletionNotification(harness.pi.events, payload, "stable-notify"), true);
	assert.equal(harness.sends(), 2, "the duplicate request is acknowledged without another message");
	unregister();
});

test("local completion acknowledgement waits for rejected async delivery before retrying", async () => {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	let sends = 0;
	const events = {
		on(event: string, handler: (data: unknown) => void) {
			const set = listeners.get(event) ?? new Set();
			set.add(handler);
			listeners.set(event, set);
			return () => set.delete(handler);
		},
		emit(event: string, payload: unknown) {
			for (const handler of listeners.get(event) ?? []) handler(payload);
		},
	};
	const pi = {
		events,
		sendMessage: async () => {
			sends += 1;
			if (sends === 1) throw new Error("async notification failure");
		},
	};
	const unregister = registerSubagentNotify(pi as never);
	const payload = { id: "async-notify-run", agent: "worker", success: true, summary: "done" };

	assert.equal(await deliverLocalCompletionNotification(events, payload, "stable-async-notify"), false);
	assert.equal(await deliverLocalCompletionNotification(events, payload, "stable-async-notify"), true);
	assert.equal(sends, 2);
	unregister();
});

test("queued child messages drain before a direct terminal notification", () => {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const pendingIdle = ["Ready…"];
	const delivered: string[] = [];
	const events = {
		on(event: string, handler: (data: unknown) => void) {
			const set = listeners.get(event) ?? new Set();
			set.add(handler);
			listeners.set(event, set);
			return () => set.delete(handler);
		},
		emit(event: string, payload: unknown) {
			for (const handler of listeners.get(event) ?? []) handler(payload);
		},
	};
	events.on("subagent:terminal-ordering-barrier", () => {
		delivered.push(...pendingIdle.splice(0));
	});
	const pi = {
		events,
		sendMessage(message: { customType: string }) {
			delivered.push(message.customType);
		},
	};
	registerSubagentNotify(pi as never);

	events.emit("subagent:async-complete", {
		id: "ordering-run",
		runId: "ordering-run",
		agent: "worker",
		success: false,
		state: "paused",
		summary: "Paused after interrupt.",
		timestamp: 2,
		results: [{ agent: "worker", intercomTarget: "subagent-worker-ordering-run-1" }],
	});
	delivered.push(...pendingIdle.splice(0));

	assert.deepEqual(delivered, ["Ready…", "subagent-notify"]);
});

test("stale terminal-barrier emits do not escape the completion callback", async () => {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	let stale = false;
	let sends = 0;
	const events = {
		on(event: string, handler: (data: unknown) => void) {
			const set = listeners.get(event) ?? new Set();
			set.add(handler);
			listeners.set(event, set);
			return () => set.delete(handler);
		},
		emit(event: string, payload: unknown) {
			if (stale && event === "subagent:terminal-ordering-barrier") {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			}
			for (const handler of listeners.get(event) ?? []) handler(payload);
		},
	};
	const pi = {
		events,
		sendMessage() {
			sends += 1;
		},
	};
	const unregister = registerSubagentNotify(pi as never);
	stale = true;

	const delivered = await deliverLocalCompletionNotification(
		events,
		{ id: "stale-barrier-run", agent: "worker", summary: "done" },
		"stale-barrier-notify",
	);

	assert.equal(delivered, true, "a stale barrier falls back to direct notification delivery");
	assert.equal(sends, 1);
	unregister();
});

test("does not acknowledge a terminal notification when barrier dispatch fails", async () => {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	let sendAttempts = 0;
	const events = {
		on(event: string, handler: (data: unknown) => void) {
			const set = listeners.get(event) ?? new Set();
			set.add(handler);
			listeners.set(event, set);
			return () => set.delete(handler);
		},
		emit(event: string, payload: unknown) {
			if (event === "subagent:terminal-ordering-barrier") {
				(payload as { dispatch?: (prefix: unknown[]) => unknown }).dispatch?.([]);
				return;
			}
			for (const handler of listeners.get(event) ?? []) handler(payload);
		},
	};
	const pi = {
		events,
		sendMessages() {
			sendAttempts += 1;
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
		sendMessage() {
			sendAttempts += 1;
		},
	};
	const unregister = registerSubagentNotify(pi as never);
	const payload = { id: "failed-barrier-run", agent: "worker", summary: "done" };

	assert.equal(await deliverLocalCompletionNotification(events, payload, "failed-barrier-notify"), false);
	assert.equal(await deliverLocalCompletionNotification(events, payload, "failed-barrier-notify"), false);
	assert.equal(sendAttempts, 2, "a failed dispatch remains retryable and never falls through to success");
	unregister();
});

test("keeps a surviving notification handler when replacement cleanup throws", () => {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	let onCalls = 0;
	let sends = 0;
	const events = {
		on(event: string, handler: (data: unknown) => void) {
			onCalls += 1;
			if (onCalls === 2) throw new Error("This extension ctx is stale after session replacement or reload.");
			const set = listeners.get(event) ?? new Set();
			set.add(handler);
			listeners.set(event, set);
			return () => {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			};
		},
		emit(event: string, payload: unknown) {
			for (const handler of listeners.get(event) ?? []) handler(payload);
		},
	};
	const pi = {
		events,
		sendMessage: () => {
			sends += 1;
		},
	};
	const firstCleanup = registerSubagentNotify(pi as never);

	assert.doesNotThrow(() => registerSubagentNotify(pi as never));
	events.emit("subagent:async-complete", {
		id: "surviving-handler-run",
		agent: "worker",
		status: "ok",
		summary: "done",
		timestamp: Date.now(),
	});
	assert.equal(onCalls, 2);
	assert.equal(sends, 1);
	firstCleanup();
	events.emit("subagent:async-complete", {
		id: "after-cleanup-run",
		agent: "worker",
		status: "ok",
		summary: "done",
		timestamp: Date.now(),
	});
	assert.equal(sends, 1);
});

test("re-registers a per-run completion subscription after invalidation", () => {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	let onCalls = 0;
	let stale = false;
	const events = {
		on(event: string, handler: (data: unknown) => void) {
			onCalls += 1;
			if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
			const set = listeners.get(event) ?? new Set();
			set.add(handler);
			listeners.set(event, set);
			return () => set.delete(handler);
		},
		emit(event: string, payload: unknown) {
			for (const handler of listeners.get(event) ?? []) handler(payload);
		},
	};
	const sent: unknown[] = [];
	const pi = { events, sendMessage: (message: unknown) => sent.push(message) };
	const firstCleanup = registerSubagentNotify(pi as never);

	stale = true;
	assert.doesNotThrow(() => registerSubagentNotify(pi as never));
	stale = false;
	const secondCleanup = registerSubagentNotify(pi as never);
	assert.equal(onCalls, 3, "the retry registers a fresh event-bus subscription");

	events.emit("subagent:async-complete", {
		id: "reloaded-run",
		agent: "worker",
		status: "ok",
		summary: "done",
		timestamp: Date.now(),
	});
	assert.equal(sent.length, 1);
	firstCleanup();
	secondCleanup();
});

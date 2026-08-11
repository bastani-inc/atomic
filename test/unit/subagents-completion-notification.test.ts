import assert from "node:assert/strict";
import { type ExtensionAPI, isStaleExtensionContextError, STALE_EXTENSION_CONTEXT_MARKER } from "@bastani/atomic";
import { test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import {
	createExtensionRuntime,
	loadExtensionFromFactory,
} from "../../packages/coding-agent/src/core/extensions/loader.js";
import { deliverLocalCompletionNotification } from "../../packages/subagents/src/runs/background/completion-notification.js";
import registerSubagentNotify from "../../packages/subagents/src/runs/background/notify.js";

async function loadNotifyRegistration(
	eventBus: ReturnType<typeof createEventBus>,
	sendMessage: () => void,
	extensionPath: string,
) {
	const runtime = createExtensionRuntime();
	runtime.sendMessage = () => sendMessage();
	const registrations: Array<{ pi: ExtensionAPI; cleanup: () => void }> = [];
	await loadExtensionFromFactory(
		(pi) => {
			registrations.push({ pi, cleanup: registerSubagentNotify(pi) });
		},
		process.cwd(),
		eventBus,
		runtime,
		extensionPath,
	);
	assert.equal(registrations.length, 1);
	return { runtime, ...registrations[0]! };
}

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

test("stale completion notification emits reject instead of reporting ordinary non-delivery", async () => {
	const events = {
		on: () => () => {},
		emit: () => {
			throw new Error(STALE_EXTENSION_CONTEXT_MARKER);
		},
	};

	await assert.rejects(
		deliverLocalCompletionNotification(events, { id: "stale-notify" }, "stale-notify"),
		(error: unknown) => isStaleExtensionContextError(error),
	);
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

test("keeps the existing completion subscription when replacement registration fails", () => {
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
	const registry = (globalThis as Record<string, unknown>).__piSubagentsNotifyRegistrations as WeakMap<
		object,
		{ unsubscribe: () => void }
	>;

	stale = true;
	assert.doesNotThrow(() => registerSubagentNotify(pi as never));
	assert.equal(onCalls, 2, "the rejected replacement still attempted one subscription");
	assert.ok(registry.get(pi), "the rejected replacement keeps the existing registry entry");

	events.emit("subagent:async-complete", {
		id: "surviving-registration-run",
		agent: "worker",
		status: "ok",
		summary: "done",
		timestamp: Date.now(),
	});
	assert.equal(sent.length, 1, "the existing handler survives the rejected replacement");
	firstCleanup();
	events.emit("subagent:async-complete", {
		id: "after-cleanup-run",
		agent: "worker",
		status: "ok",
		summary: "done",
		timestamp: Date.now(),
	});
	assert.equal(sent.length, 1);
});

test("delivers completions through a replacement API after invalidation", async () => {
	const eventBus = createEventBus();
	let oldSends = 0;
	let replacementSends = 0;
	const old = await loadNotifyRegistration(
		eventBus,
		() => {
			oldSends += 1;
		},
		"<completion-notification-old>",
	);
	const registry = (globalThis as Record<string, unknown>).__piSubagentsNotifyRegistrations as WeakMap<
		object,
		{ unsubscribe: () => void }
	>;
	assert.ok(registry.get(old.pi), "the original API owns a notification registration");

	old.runtime.invalidate();
	old.cleanup();
	const replacement = await loadNotifyRegistration(
		eventBus,
		() => {
			replacementSends += 1;
		},
		"<completion-notification-replacement>",
	);

	assert.notStrictEqual(old.pi, replacement.pi, "reload creates a distinct extension API");
	assert.equal(registry.get(old.pi), undefined, "the invalidated API no longer owns a registry entry");
	assert.ok(registry.get(replacement.pi), "the replacement API owns the live registry entry");
	replacement.pi.events.emit("subagent:async-complete", {
		id: "replacement-registration-run",
		agent: "worker",
		status: "ok",
		summary: "done",
		timestamp: Date.now(),
	});
	assert.equal(oldSends, 0, "the invalidated API cannot receive the replacement completion");
	assert.equal(replacementSends, 1, "the replacement API delivers the completion");

	replacement.cleanup();
	assert.equal(registry.get(replacement.pi), undefined);
});

test("wraps a double failure in AggregateError with the registry already rolled back", () => {
	// Greptile P2 on PR #2306: the both-cleanups-fail branch promised
	// "preserve both errors if rollback also fails" and nothing entered it.
	// The prior subscription's unsubscribe AND the new handler's rollback
	// unsubscribe both throw non-stale errors here.
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	let onCalls = 0;
	const events = {
		on(event: string, handler: (data: unknown) => void) {
			onCalls += 1;
			const set = listeners.get(event) ?? new Set();
			set.add(handler);
			listeners.set(event, set);
			const subscriptionCall = onCalls;
			return () => {
				if (subscriptionCall === 1) throw new Error("injected replacement cleanup failure");
				throw new Error("injected rollback failure");
			};
		},
		emit(event: string, payload: unknown) {
			for (const handler of listeners.get(event) ?? []) handler(payload);
		},
	};
	const pi = { events, sendMessage: () => {} };
	registerSubagentNotify(pi as never);
	const registry = (globalThis as Record<string, unknown>).__piSubagentsNotifyRegistrations as WeakMap<
		object,
		{ unsubscribe: () => void }
	>;
	assert.ok(registry.get(pi), "the first subscription is registered");

	let caught: unknown;
	try {
		registerSubagentNotify(pi as never);
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof AggregateError, "double failure surfaces as AggregateError");
	assert.match(caught.message, /Failed to roll back notification registration/);
	assert.equal(caught.errors.length, 2, "both errors are preserved");
	assert.match(String(caught.errors[0]), /injected replacement cleanup failure/);
	assert.match(String(caught.errors[1]), /injected rollback failure/);
	assert.equal(registry.get(pi), undefined, "registry is rolled back before the AggregateError escapes");
});

test("rolls back a failed replacement before activation can expose a registry entry", () => {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const activeHandlers = new Set<(data: unknown) => void>();
	const registeredHandlers: Array<(data: unknown) => void> = [];
	let onCalls = 0;
	let sends = 0;
	const events = {
		on(event: string, handler: (data: unknown) => void) {
			onCalls += 1;
			registeredHandlers.push(handler);
			const set = listeners.get(event) ?? new Set();
			set.add(handler);
			listeners.set(event, set);
			activeHandlers.add(handler);
			const subscriptionCall = onCalls;
			return () => {
				if (subscriptionCall === 1) throw new Error("injected replacement cleanup failure");
				activeHandlers.delete(handler);
				set.delete(handler);
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
	const registry = (globalThis as Record<string, unknown>).__piSubagentsNotifyRegistrations as WeakMap<
		object,
		{ unsubscribe: () => void }
	>;
	assert.ok(registry.get(pi), "the first subscription is registered");

	assert.throws(() => registerSubagentNotify(pi as never), /injected replacement cleanup failure/);
	assert.equal(registry.get(pi), undefined, "failed activation leaves no notification registry entry");
	assert.equal(activeHandlers.has(registeredHandlers[1]!), false, "the failed replacement is unsubscribed");

	events.emit("subagent:async-complete", {
		id: "rolled-back-run",
		agent: "worker",
		status: "ok",
		summary: "must not deliver",
		timestamp: Date.now(),
	});
	assert.equal(sends, 0, "no subscription remains active after the failed activation");
	firstCleanup();
});

/**
 * The root mirror of a stage on a local worker reconnects after its attempt ends and
 * redelivers what the replacement attempt does not hold (#3996).
 */
import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@bastani/atomic";
import { test } from "vitest";
import {
	type OutboundEntry,
	openPooledStageHandle,
	type PooledStageTransport,
	reconnectPooledStageHandle,
} from "../../packages/workflows/src/workers/pooled-stage-handle.js";
import type {
	DeliveryOpId,
	PooledStageChatSnapshot,
	PooledStageDelivery,
	PooledStageWatchMessage,
	WatchId,
} from "../../packages/workflows/src/workers/stage-watch-types.js";

function snapshot(deliveredOps: readonly string[] = []): PooledStageChatSnapshot {
	return {
		sessionId: "session",
		status: "running",
		isStreaming: true,
		messages: [],
		pendingToolExecutionEvents: [],
		queued: { steering: [], followUp: [] },
		deliveredOps: deliveredOps as readonly DeliveryOpId[],
		seq: 0,
	};
}

/** A pool whose first attempt dies after the test's deliveries; the second holds `present` ops. */
function pool(present: (delivered: readonly PooledStageDelivery[]) => readonly string[]) {
	const deliveries: PooledStageDelivery[] = [];
	const unwatched: WatchId[] = [];
	let hold: Promise<void> | undefined;
	const started = Promise.withResolvers<void>();
	const listeners: ((message: PooledStageWatchMessage) => void)[] = [];
	let generation = 0;
	let watches = 0;
	/** A new attempt runs the stage only after the current one ended. */
	let replaced = true;
	const transport: PooledStageTransport = {
		async watch(_ref, listener) {
			listeners.push(listener);
			watches++;
			if (replaced) {
				generation++;
				replaced = false;
			}
			return {
				ok: true,
				watch: {
					id: `watch-${watches}` as WatchId,
					attempt: { workId: "work", generation },
					snapshot: snapshot(generation === 1 ? [] : present(deliveries)),
				},
			};
		},
		async unwatch(watch) {
			unwatched.push(watch);
		},
		async deliver(delivery) {
			deliveries.push(delivery);
			if (hold !== undefined) {
				started.resolve();
				await hold;
			}
			return { ok: true, action: delivery.intent === "followUp" ? "followUp" : "steer" };
		},
		async pause() {
			return { ok: true };
		},
		async resume() {
			return { ok: true };
		},
	};
	return {
		transport,
		deliveries,
		unwatched,
		deliveryStarted: started.promise,
		holdDeliveries(until: Promise<void>) {
			hold = until;
		},
		end(reason: "worker_exited" | "stage_finished") {
			replaced = true;
			listeners.at(-1)?.({ kind: "ended", reason });
		},
		events(seq: number, event: AgentSessionEvent) {
			listeners.at(-1)?.({ kind: "events", events: [{ seq, event }] });
		},
	};
}

test("after its worker dies the handle reconnects and redelivers, once each and in order, what the replacement lacks (#3996)", async () => {
	// The replacement's session already holds the first message (its op was recorded before the kill).
	const fake = pool((delivered) => [delivered[0]!.op]);
	const opened = await openPooledStageHandle(fake.transport, { runId: "child", stageId: "agent" }, "agent");
	assert.ok(opened.ok);
	const handle = opened.handle;
	await handle.steer("consumed before the kill");
	await handle.steer("still queued");
	await handle.followUp("queued follow-up");
	fake.end("worker_exited");
	assert.equal(handle.isReconnecting, true);
	assert.equal(handle.placement.reconnecting, true);
	const redelivered: number[] = [];
	handle.onRebind((count) => redelivered.push(count));

	// While the rebind redelivers, the handle still reads as reconnecting.
	const gate = Promise.withResolvers<void>();
	fake.holdDeliveries(gate.promise);
	const reconnecting = reconnectPooledStageHandle(handle, fake.transport);
	await fake.deliveryStarted;
	assert.equal(handle.placement.reconnecting, true, "RECONNECTING shows for the whole rebind");
	gate.resolve();
	assert.equal(await reconnecting, true);
	const original = fake.deliveries.slice(0, 3);
	assert.deepEqual(
		fake.deliveries.slice(3).map(({ watch, op, text, intent }) => ({ watch, op, text, intent })),
		[
			{ watch: "watch-2", op: original[1]!.op, text: "still queued", intent: "steer" },
			{ watch: "watch-2", op: original[2]!.op, text: "queued follow-up", intent: "followUp" },
		],
		"only what the replacement lacks is sent again, under its original op and in its original mode",
	);
	assert.deepEqual(redelivered, [2]);
	assert.deepEqual(handle.placement, { kind: "local-worker", workId: "work", generation: 2, redelivered: 2 });
	assert.deepEqual(fake.unwatched, ["watch-1"]);
});

test("a stage that finished ends the handle instead of reconnecting it (#3996)", async () => {
	const fake = pool(() => []);
	const opened = await openPooledStageHandle(fake.transport, { runId: "child", stageId: "agent" }, "agent");
	assert.ok(opened.ok);
	fake.end("stage_finished");
	assert.equal(opened.handle.isReconnecting, false);
	assert.equal(opened.handle.endReason, "stage_finished");
	assert.equal(await reconnectPooledStageHandle(opened.handle, fake.transport), false);
});

test("text sent while a rebind redelivers waits behind the redelivery, so the replacement gets it in send order (#3996)", async () => {
	const fake = pool(() => []);
	const opened = await openPooledStageHandle(fake.transport, { runId: "child", stageId: "agent" }, "agent");
	assert.ok(opened.ok);
	const handle = opened.handle;
	await handle.steer("A");
	await handle.followUp("B");
	fake.end("worker_exited");
	const gate = Promise.withResolvers<void>();
	fake.holdDeliveries(gate.promise);
	const reconnecting = reconnectPooledStageHandle(handle, fake.transport);
	await fake.deliveryStarted;
	const sentDuringRebind = handle.steer("C");
	gate.resolve();
	assert.equal(await reconnecting, true);
	await sentDuringRebind;
	assert.deepEqual(
		fake.deliveries.slice(2).map(({ watch, text, intent }) => ({ watch, text, intent })),
		[
			{ watch: "watch-2", text: "A", intent: "steer" },
			{ watch: "watch-2", text: "B", intent: "followUp" },
			{ watch: "watch-2", text: "C", intent: "steer" },
		],
	);
});

test("a replacement that dies mid-rebind leaves the handle reconnecting, and the next attempt gets the rest (#3996)", async () => {
	const fake = pool(() => []);
	const opened = await openPooledStageHandle(fake.transport, { runId: "child", stageId: "agent" }, "agent");
	assert.ok(opened.ok);
	const handle = opened.handle;
	await handle.steer("A");
	fake.end("worker_exited");
	const gate = Promise.withResolvers<void>();
	fake.holdDeliveries(gate.promise);
	const second = reconnectPooledStageHandle(handle, fake.transport);
	await fake.deliveryStarted;
	fake.end("worker_exited");
	gate.resolve();
	assert.equal(await second, false, "the second attempt ended before the rebind finished");
	assert.equal(handle.isReconnecting, true);
	assert.equal(await reconnectPooledStageHandle(handle, fake.transport), true);
	assert.deepEqual(
		fake.deliveries.map(({ watch, text }) => `${watch}:${text}`),
		["watch-1:A", "watch-2:A", "watch-3:A"],
	);
	assert.equal(handle.isReconnecting, false);
});

test("a stage that finishes while reconnecting no longer reads as reconnecting (#3996)", async () => {
	const fake = pool(() => []);
	const opened = await openPooledStageHandle(fake.transport, { runId: "child", stageId: "agent" }, "agent");
	assert.ok(opened.ok);
	fake.end("worker_exited");
	assert.equal(opened.handle.placement.reconnecting, true);
	opened.handle.receive({ kind: "ended", reason: "stage_finished" });
	assert.equal(opened.handle.isReconnecting, false);
	assert.equal(opened.handle.placement.reconnecting, undefined);
	assert.equal(opened.handle.endReason, "stage_finished");
});

/** A transport whose replacement attempt opens with the snapshot fields the test gives it. */
function replacementPool(replacement: Partial<PooledStageChatSnapshot>) {
	const fake = pool(() => []);
	const watch = fake.transport.watch;
	let opened = 0;
	fake.transport.watch = async (ref, listener) => {
		const result = await watch(ref, listener);
		opened++;
		return result.ok && opened > 1
			? { ok: true, watch: { ...result.watch, snapshot: { ...result.watch.snapshot, ...replacement } } }
			: result;
	};
	return fake;
}

test.each([
	["already mid-turn without a new agent_start", { isStreaming: false, turnStarted: true }],
	["idle after its turn", { isStreaming: false, turnStarted: true }],
] as const)("a replacement %s gets its redelivery at once (#3996)", async (_label, replacement) => {
	const fake = replacementPool(replacement);
	const opened = await openPooledStageHandle(fake.transport, { runId: "child", stageId: "agent" }, "agent");
	assert.ok(opened.ok);
	await opened.handle.steer("STEER");
	await opened.handle.followUp("FOLLOW");
	fake.end("worker_exited");
	assert.equal(await reconnectPooledStageHandle(opened.handle, fake.transport), true);
	assert.deepEqual(
		fake.deliveries.slice(2).map(({ watch, text, intent }) => `${watch}:${text}:${intent}`),
		["watch-2:STEER:steer", "watch-2:FOLLOW:followUp"],
	);
	assert.equal(opened.handle.isReconnecting, false);
});

test("a replacement that has not started its turn gets the redelivery once its turn is under way (#3996)", async () => {
	const fake = replacementPool({ isStreaming: false, turnStarted: false });
	const opened = await openPooledStageHandle(fake.transport, { runId: "child", stageId: "agent" }, "agent");
	assert.ok(opened.ok);
	await opened.handle.steer("STEER");
	fake.end("worker_exited");
	const reconnecting = reconnectPooledStageHandle(opened.handle, fake.transport);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(fake.deliveries.length, 1, "nothing is redelivered before the replay's own prompt");
	assert.equal(opened.handle.placement.reconnecting, true);
	// A tool call of the replay's turn, without a fresh agent_start.
	fake.events(1, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} } as never);
	assert.equal(await reconnecting, true);
	assert.deepEqual(
		fake.deliveries.slice(1).map(({ watch, text }) => `${watch}:${text}`),
		["watch-2:STEER"],
	);
});

test("text waiting in a stage's outbox survives a closed view and reaches the stage once (#3996)", async () => {
	const fake = pool(() => []);
	const outbox: OutboundEntry[] = [];
	const first = await openPooledStageHandle(
		fake.transport,
		{ runId: "child", stageId: "agent" },
		"agent",
		() => {},
		outbox,
	);
	assert.ok(first.ok);
	await first.handle.steer("STEER");
	fake.end("worker_exited");
	// Sent while reconnecting: refused for now, kept for the replacement.
	await assert.rejects(first.handle.followUp("FOLLOW"), /sent again when it reconnects/);
	first.handle.dispose();
	assert.equal(outbox.length, 2, "closing the view keeps the text");
	const reopened = await openPooledStageHandle(
		fake.transport,
		{ runId: "child", stageId: "agent" },
		"agent",
		() => {},
		outbox,
	);
	assert.ok(reopened.ok);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(
		fake.deliveries.map(({ watch, text }) => `${watch}:${text}`),
		["watch-1:STEER", "watch-2:STEER", "watch-2:FOLLOW"],
	);
	const sameAttempt = await openPooledStageHandle(
		fake.transport,
		{ runId: "child", stageId: "agent" },
		"agent",
		() => {},
		outbox,
	);
	assert.ok(sameAttempt.ok);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(fake.deliveries.length, 3, "an attempt that admitted the text does not get it again");
});

test("a stage that fails while reconnecting ends the reconnect and reports the text it never got (#3996)", async () => {
	const fake = pool(() => []);
	const opened = await openPooledStageHandle(fake.transport, { runId: "child", stageId: "agent" }, "agent");
	assert.ok(opened.ok);
	await opened.handle.steer("STEER");
	await opened.handle.followUp("FOLLOW");
	fake.end("worker_exited");
	opened.handle.receive({ kind: "ended", reason: "stage_finished" });
	assert.equal(opened.handle.isReconnecting, false);
	assert.deepEqual(opened.handle.placement, {
		kind: "local-worker",
		workId: "work",
		generation: 1,
		undelivered: 2,
	});
	await assert.rejects(opened.handle.steer("late"), /finished first/);
});

test("a send whose transport rejects fails its caller at once, and the next attempt gets it exactly once (#3996)", async () => {
	const fake = pool(() => []);
	const deliver = fake.transport.deliver;
	let refuseNext = true;
	fake.transport.deliver = async (delivery) => {
		if (refuseNext) {
			refuseNext = false;
			fake.deliveries.push(delivery);
			throw new Error("coordinator went away mid-send");
		}
		return deliver(delivery);
	};
	const opened = await openPooledStageHandle(fake.transport, { runId: "child", stageId: "agent" }, "agent");
	assert.ok(opened.ok);
	await assert.rejects(opened.handle.steer("UNSURE"), /coordinator went away/);
	assert.equal(await opened.handle.followUp("NEXT"), undefined, "the queue keeps moving past it");
	fake.end("worker_exited");
	assert.equal(await reconnectPooledStageHandle(opened.handle, fake.transport), true);
	assert.deepEqual(
		fake.deliveries.map(({ watch, text }) => `${watch}:${text}`),
		["watch-1:UNSURE", "watch-1:NEXT", "watch-2:UNSURE", "watch-2:NEXT"],
	);
});

test("a worker that refuses a send after its caller went away leaves no unhandled rejection in the root (#3996)", async () => {
	const fake = pool(() => []);
	const refusal = Promise.withResolvers<never>();
	refusal.promise.catch(() => {});
	const deliver = fake.transport.deliver;
	let first = true;
	fake.transport.deliver = async (delivery) => {
		if (!first) return deliver(delivery);
		first = false;
		fake.deliveries.push(delivery);
		return refusal.promise;
	};
	const opened = await openPooledStageHandle(fake.transport, { runId: "child", stageId: "agent" }, "agent");
	assert.ok(opened.ok);
	const sent = opened.handle.steer("STEER");
	// The chat closes while the worker still holds the send.
	opened.handle.dispose();
	await assert.rejects(sent, /is closed/);
	refusal.reject(new Error("Agent is already processing a prompt. Use steer() or followUp() to queue messages."));
	// Vitest fails the run on an unhandled rejection; let it surface if there is one.
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(opened.handle.isDisposed, true);
});

test("a redelivery its worker never answers does not hold the view: a fresh watch gets the text, once (#3996)", async () => {
	const fake = pool(() => []);
	const deliver = fake.transport.deliver;
	let hang = false;
	fake.transport.deliver = (delivery) => {
		if (!hang) return deliver(delivery);
		fake.deliveries.push(delivery);
		return new Promise(() => {});
	};
	const opened = await openPooledStageHandle(fake.transport, { runId: "child", stageId: "agent" }, "agent");
	assert.ok(opened.ok);
	const handle = opened.handle;
	await handle.steer("STEER");
	fake.end("worker_exited");
	hang = true;
	// The replacement's worker never answers the redelivery: the view stays reconnecting.
	const stuck = reconnectPooledStageHandle(handle, fake.transport);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(handle.isReconnecting, true);
	// The pool gives up on that attempt and opens a fresh watch, as it does after enough activity.
	hang = false;
	assert.equal(await reconnectPooledStageHandle(handle, fake.transport, () => true), true);
	assert.equal(handle.isReconnecting, false);
	assert.deepEqual(
		fake.deliveries.map(({ watch, text }) => `${watch}:${text}`),
		["watch-1:STEER", "watch-2:STEER", "watch-3:STEER"],
	);
	assert.equal(await stuck, false, "the abandoned rebind settles");
});

test("a watch that opens after its reconnect was abandoned is closed, not bound (#3996)", async () => {
	const fake = pool(() => []);
	const opened = await openPooledStageHandle(fake.transport, { runId: "child", stageId: "agent" }, "agent");
	assert.ok(opened.ok);
	fake.end("worker_exited");
	assert.equal(await reconnectPooledStageHandle(opened.handle, fake.transport, () => false), false);
	assert.deepEqual(fake.unwatched, ["watch-2"]);
	assert.equal(opened.handle.isReconnecting, true);
});

test("a send its attempt never confirms does not hold later ones: they go, and the next attempt gets it, once (#3996)", async () => {
	const fake = pool(() => []);
	const deliver = fake.transport.deliver;
	fake.transport.deliver = (delivery) => {
		// The trace's replacement: this follow-up's admission never answers on generation 1.
		if (delivery.text === "FOLLOW" && delivery.watch === "watch-1") {
			fake.deliveries.push(delivery);
			return new Promise(() => {});
		}
		return deliver(delivery);
	};
	// A short wait: the never-answered send is soon left unconfirmed, and later tried again.
	const opened = await openPooledStageHandle(
		fake.transport,
		{ runId: "child", stageId: "agent" },
		"agent",
		() => {},
		[],
		5,
	);
	assert.ok(opened.ok);
	const handle = opened.handle;
	await assert.rejects(handle.followUp("FOLLOW"), /already arrived/);
	await handle.steer("STEER");
	assert.deepEqual(
		fake.deliveries.slice(0, 2).map(({ watch, text }) => `${watch}:${text}`),
		["watch-1:FOLLOW", "watch-1:STEER"],
		"the steer is not held behind the unconfirmed follow-up",
	);
	assert.equal(handle.hasPending, false, "an unconfirmed send does not keep the attempt busy");
	assert.deepEqual(handle.queuedUserMessages().followUp, ["FOLLOW"], "it still shows as pending");
	assert.equal(handle.placement.undelivered, 1, "and is counted, never dropped silently");
	// It is tried again on the same attempt.
	while (fake.deliveries.filter(({ text }) => text === "FOLLOW").length < 2)
		await new Promise((resolve) => setTimeout(resolve, 5));
	fake.end("worker_exited");
	assert.equal(await reconnectPooledStageHandle(handle, fake.transport), true);
	assert.deepEqual(
		fake.deliveries.filter(({ watch }) => watch === "watch-2").map(({ text }) => text),
		["FOLLOW", "STEER"],
		"the next attempt gets each once, in order (its session holds neither)",
	);
	assert.equal(handle.placement.undelivered, undefined);
});

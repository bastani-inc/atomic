import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import v8 from "node:v8";
import vm from "node:vm";
import type { DetachedToolCall, DetachedToolResult } from "@bastani/atomic";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { StageAbortListeners } from "../../packages/workflows/src/runs/foreground/stage-abort-listeners.js";
import {
	type StageWaitEntry,
	StageWakeDispatcher,
	type StageWakeReport,
	stageWakeKey,
} from "../../packages/workflows/src/runs/foreground/stage-wake-dispatcher.js";
import {
	deliverStageWake,
	isStageWakeError,
	registerStageWakeKind,
	type StageWake,
	StageWakeError,
	type StageWakeHandlerContext,
} from "../../packages/workflows/src/sdk-surface.js";

declare module "@bastani/atomic/workflows" {
	interface StageWakeKinds {
		/** Registered without a handler for the whole file: queues for the next wait of its kind. */
		"test-ping": { readonly note: string };
		/** Registered with a handler by the tests that need one. */
		"test-handled": { readonly note: string };
		/** Never registered. */
		"test-unregistered": { readonly note: string };
	}
}

const RUN = "run-dispatcher";

function identity(stageId: string, runId = RUN): { runId: string; stageId: string; wakeKey: string } {
	return { runId, stageId, wakeKey: stageWakeKey(runId, stageId) };
}

function entry(stageId: string, runId = RUN, reason: StageWaitEntry["reason"] = "tool"): StageWaitEntry {
	return { ...identity(stageId, runId), reason };
}

function toolResult(toolCallId: string, text = "ci passed"): DetachedToolResult {
	return {
		toolCallId,
		toolName: "wait_for_ci",
		result: { content: [{ type: "text", text }], details: undefined },
		isError: false,
	};
}

function toolResults(...toolCallIds: string[]): StageWake {
	return { kind: "tool-results", results: toolCallIds.map((id) => toolResult(id)) };
}

function ping(note: string): StageWake {
	return { kind: "test-ping", note };
}

function handled(note: string): StageWake {
	return { kind: "test-handled", note };
}

function unregistered(note: string): StageWake {
	return { kind: "test-unregistered", note };
}

/** A dispatcher whose reports are collected instead of logged. */
function recording(
	runId = RUN,
	signal?: AbortSignal,
): { readonly dispatcher: StageWakeDispatcher; readonly reports: StageWakeReport[] } {
	const reports: StageWakeReport[] = [];
	return { dispatcher: new StageWakeDispatcher(runId, signal, { report: (report) => reports.push(report) }), reports };
}

/** A detached call whose result the test settles. */
function deferredCall(toolCallId: string): {
	readonly call: DetachedToolCall;
	readonly settle: (text?: string) => void;
	readonly fail: (error: Error) => void;
} {
	const result = Promise.withResolvers<DetachedToolResult>();
	return {
		call: { toolCallId, toolName: "wait_for_ci", result: result.promise, abort() {} },
		settle: (text) => result.resolve(toolResult(toolCallId, text)),
		fail: (error) => result.reject(error),
	};
}

/** What a promise did by now: its value, or the reason it was rejected with, or that it is still pending. */
async function outcome<T>(
	promise: Promise<T>,
): Promise<{ state: "pending" } | { state: "resolved"; value: T } | { state: "rejected"; reason: unknown }> {
	const pending = Symbol("pending");
	const settled = await Promise.race([
		promise.then(
			(value) => ({ state: "resolved" as const, value }),
			(reason: unknown) => ({ state: "rejected" as const, reason }),
		),
		new Promise<typeof pending>((resolve) => setImmediate(() => resolve(pending))),
	]);
	return settled === pending ? { state: "pending" } : settled;
}

async function settle(): Promise<void> {
	for (let round = 0; round < 5; round++) await new Promise((resolve) => setImmediate(resolve));
}

function aborted(reason?: unknown): AbortSignal {
	const controller = new AbortController();
	controller.abort(reason);
	return controller.signal;
}

function resolveCollect(): () => void {
	const existing = (globalThis as { gc?: () => void }).gc;
	if (typeof existing === "function") return existing;
	v8.setFlagsFromString("--expose-gc");
	try {
		return vm.runInNewContext("gc") as () => void;
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

describe("StageWakeDispatcher (#4309)", () => {
	let removePing: () => void = () => {};
	beforeAll(() => {
		removePing = registerStageWakeKind("test-ping");
	});
	afterAll(() => removePing());

	test("a stage takes the message delivered to it while it was parked, and the delivery says so", async () => {
		const { dispatcher } = recording();
		const waiting = entry("stage-1");
		dispatcher.register(waiting);
		const parked = dispatcher.park(waiting.wakeKey, "tool-results");
		assert.equal((await outcome(parked)).state, "pending");

		const wake = toolResults("call-1");
		assert.deepEqual(dispatcher.deliver(waiting.wakeKey, wake), { status: "delivered" });

		assert.deepEqual(await outcome(parked), { state: "resolved", value: wake });
		dispatcher.dispose();
	});

	test("a message delivered before the stage parks queues for it, and a later park takes it at once", async () => {
		const { dispatcher } = recording();
		const waiting = entry("stage-1");
		dispatcher.register(waiting);
		const wake = toolResults("call-1");

		assert.deepEqual(dispatcher.deliver(waiting.wakeKey, wake), { status: "queued" });

		assert.deepEqual(await outcome(dispatcher.park(waiting.wakeKey, "tool-results")), {
			state: "resolved",
			value: wake,
		});
		// The message was consumed: the next park waits.
		assert.equal((await outcome(dispatcher.park(waiting.wakeKey, "tool-results"))).state, "pending");
		dispatcher.dispose();
	});

	test("a stage whose mailbox is not open refuses messages, parks and watches, and queues nothing", async () => {
		const { dispatcher } = recording();
		const stranger = identity("stranger");

		assert.deepEqual(dispatcher.deliver(stranger.wakeKey, toolResults("call-1")), { status: "stage-not-open" });
		const refused = await outcome(dispatcher.park(stranger.wakeKey, "tool-results"));
		assert.ok(refused.state === "rejected" && refused.reason instanceof DOMException);
		assert.equal(refused.reason.name, "AbortError");
		assert.equal(refused.reason.message, `atomic-workflows: stage ${stranger.wakeKey} is not open`);
		assert.throws(
			() => dispatcher.watchToolResults(stranger.wakeKey, []),
			(error: unknown) => error instanceof DOMException && error.name === "InvalidStateError",
		);

		// Opened later, its mailbox starts empty: the refused message is not there.
		dispatcher.open(stranger);
		assert.equal((await outcome(dispatcher.park(stranger.wakeKey, "tool-results"))).state, "pending");
		dispatcher.dispose();
	});

	test("an open stage that does not wait is not in the resident index, and still takes messages it parks for", async () => {
		const { dispatcher } = recording();
		const resident = identity("stage-1");
		dispatcher.open(resident);
		dispatcher.open(resident);
		assert.equal(dispatcher.size, 0);
		assert.deepEqual(dispatcher.entries(), []);

		const parked = dispatcher.park(resident.wakeKey, "test-ping");
		const wake = ping("resident");
		assert.deepEqual(dispatcher.deliver(resident.wakeKey, wake), { status: "delivered" });
		assert.deepEqual(await outcome(parked), { state: "resolved", value: wake });
		dispatcher.dispose();
	});

	test("messages of one kind queue in order and only a park for that kind takes them", async () => {
		const { dispatcher } = recording();
		const waiting = entry("stage-1");
		dispatcher.register(waiting);
		const first = ping("first");
		const second = ping("second");
		const results = toolResults("call-1");
		dispatcher.deliver(waiting.wakeKey, first);
		dispatcher.deliver(waiting.wakeKey, results);
		dispatcher.deliver(waiting.wakeKey, second);

		// The tool results are not at the head of the queue, and are still the only message this park accepts.
		assert.deepEqual(await outcome(dispatcher.park(waiting.wakeKey, "tool-results")), {
			state: "resolved",
			value: results,
		});
		assert.deepEqual(await outcome(dispatcher.park(waiting.wakeKey, "test-ping")), {
			state: "resolved",
			value: first,
		});
		assert.deepEqual(await outcome(dispatcher.park(waiting.wakeKey, "test-ping")), {
			state: "resolved",
			value: second,
		});
		assert.equal((await outcome(dispatcher.park(waiting.wakeKey, "test-ping"))).state, "pending");
		dispatcher.dispose();
	});

	test("a parked stage keeps waiting when a message of another kind arrives, which queues for its next wait", async () => {
		const { dispatcher } = recording();
		const waiting = entry("stage-1");
		dispatcher.register(waiting);
		const parked = dispatcher.park(waiting.wakeKey, "tool-results");
		const other = ping("not for this wait");

		assert.deepEqual(dispatcher.deliver(waiting.wakeKey, other), { status: "queued" });
		assert.equal((await outcome(parked)).state, "pending");

		const wake = toolResults("call-1");
		dispatcher.deliver(waiting.wakeKey, wake);
		assert.deepEqual(await outcome(parked), { state: "resolved", value: wake });
		assert.deepEqual(await outcome(dispatcher.park(waiting.wakeKey, "test-ping")), {
			state: "resolved",
			value: other,
		});
		dispatcher.dispose();
	});

	test("a message ends one wait only: the next message of that kind queues, and a second park meanwhile is refused", async () => {
		const { dispatcher } = recording();
		const waiting = entry("stage-1");
		dispatcher.register(waiting);
		const parked = dispatcher.park(waiting.wakeKey, "tool-results");
		const refused = await outcome(dispatcher.park(waiting.wakeKey, "tool-results"));
		assert.ok(refused.state === "rejected" && refused.reason instanceof DOMException);
		assert.equal(refused.reason.name, "InvalidStateError");
		const first = toolResults("call-1");
		const second = toolResults("call-2");

		assert.deepEqual(dispatcher.deliver(waiting.wakeKey, first), { status: "delivered" });
		assert.deepEqual(dispatcher.deliver(waiting.wakeKey, second), { status: "queued" });

		assert.deepEqual(await outcome(parked), { state: "resolved", value: first });
		assert.deepEqual(await outcome(dispatcher.park(waiting.wakeKey, "tool-results")), {
			state: "resolved",
			value: second,
		});
		dispatcher.dispose();
	});

	test("registering a stage that already waits keeps its first entry and its queued messages", async () => {
		const { dispatcher } = recording();
		const first = entry("stage-1");
		dispatcher.register(first);
		const wake = toolResults("call-1");
		dispatcher.deliver(first.wakeKey, wake);

		dispatcher.register({ ...first, reason: "release" });

		assert.deepEqual(dispatcher.entries(), [first]);
		assert.equal(dispatcher.entries()[0], first);
		assert.equal(dispatcher.size, 1);
		assert.deepEqual(await outcome(dispatcher.park(first.wakeKey, "tool-results")), {
			state: "resolved",
			value: wake,
		});
		dispatcher.dispose();
	});

	test("a message queued during one wait survives the end of that wait, and the stage's next wait of its kind takes it", async () => {
		const { dispatcher, reports } = recording();
		const waiting = entry("stage-1");
		dispatcher.register(waiting);
		const results = dispatcher.park(waiting.wakeKey, "tool-results");
		const later = ping("for the next wait");
		assert.deepEqual(dispatcher.deliver(waiting.wakeKey, later), { status: "queued" });
		dispatcher.deliver(waiting.wakeKey, toolResults("call-1"));
		assert.equal((await outcome(results)).state, "resolved");

		dispatcher.unregister(waiting.wakeKey);
		assert.equal(dispatcher.size, 0);
		assert.deepEqual(dispatcher.entries(), []);
		dispatcher.register({ ...waiting, reason: "release" });

		assert.deepEqual(await outcome(dispatcher.park(waiting.wakeKey, "test-ping")), {
			state: "resolved",
			value: later,
		});
		dispatcher.close(waiting.wakeKey);
		assert.deepEqual(reports, []);
		dispatcher.dispose();
	});

	test("the resident index lists one entry per waiting stage, and unregistering one leaves the others", () => {
		const { dispatcher } = recording();
		const one = entry("stage-1");
		const two = entry("stage-2");
		assert.deepEqual(dispatcher.entries(), []);
		assert.equal(dispatcher.size, 0);

		dispatcher.register(one);
		dispatcher.register(two);
		assert.deepEqual(dispatcher.entries(), [one, two]);
		assert.equal(dispatcher.size, 2);

		dispatcher.unregister(one.wakeKey);
		dispatcher.unregister(one.wakeKey);
		dispatcher.unregister(stageWakeKey(RUN, "stranger"));

		assert.deepEqual(dispatcher.entries(), [two]);
		assert.equal(dispatcher.size, 1);
		// Its mailbox is still open.
		assert.deepEqual(dispatcher.deliver(one.wakeKey, toolResults("call-1")), { status: "queued" });
		dispatcher.dispose();
	});

	test("closing a stage reports its unread messages once, with their kinds in order, and refuses later messages", async () => {
		const { dispatcher, reports } = recording();
		const stage = identity("stage-1");
		dispatcher.open(stage);
		dispatcher.deliver(stage.wakeKey, ping("never read"));
		// Opening an open stage again keeps what it queued.
		dispatcher.open(stage);
		dispatcher.register(entry("stage-1"));
		dispatcher.deliver(stage.wakeKey, toolResults("call-1"));
		const quiet = identity("stage-2");
		dispatcher.open(quiet);

		dispatcher.close(stage.wakeKey);
		dispatcher.close(stage.wakeKey);
		dispatcher.close(quiet.wakeKey);

		assert.deepEqual(reports, [
			{ reason: "stage-ended", runId: RUN, stageId: "stage-1", kinds: ["test-ping", "tool-results"] },
		]);
		assert.equal(dispatcher.size, 0);
		assert.deepEqual(dispatcher.deliver(stage.wakeKey, ping("late")), { status: "stage-not-open" });
		assert.equal(reports.length, 1);
		dispatcher.dispose();
		assert.equal(reports.length, 1);
	});

	test("closing a stage that is parked rejects its wait, and results of calls it watched no longer reach it", async () => {
		const { dispatcher, reports } = recording();
		const waiting = entry("stage-1");
		dispatcher.register(waiting);
		const ci = deferredCall("call-1");
		dispatcher.watchToolResults(waiting.wakeKey, [ci.call]);
		const parked = dispatcher.park(waiting.wakeKey, "tool-results");

		dispatcher.close(waiting.wakeKey);
		const ended = await outcome(parked);
		assert.ok(ended.state === "rejected" && ended.reason instanceof DOMException);
		assert.equal(ended.reason.name, "AbortError");

		// Reopened under the same key, the stage gets nothing from the old watch.
		dispatcher.open(waiting);
		const next = dispatcher.park(waiting.wakeKey, "tool-results");
		ci.settle();
		await settle();
		assert.equal((await outcome(next)).state, "pending");
		assert.deepEqual(reports, []);
		dispatcher.dispose();
	});

	test("disposing the dispatcher closes every open stage and reports unread messages as ended with the run", () => {
		const runId = "run-disposed";
		const { dispatcher, reports } = recording(runId);
		dispatcher.open(identity("stage-1", runId));
		dispatcher.register(entry("stage-2", runId));
		dispatcher.deliver(stageWakeKey(runId, "stage-2"), ping("unread"));

		dispatcher.dispose();

		assert.deepEqual(reports, [{ reason: "run-ended", runId, stageId: "stage-2", kinds: ["test-ping"] }]);
		assert.equal(dispatcher.size, 0);
		assert.deepEqual(deliverStageWake(runId, "stage-2", ping("after")), { status: "run-not-live" });
	});

	test("without a report option, each report is one warning naming the stage, the run and the unread kinds", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const dispatcher = new StageWakeDispatcher("run-warned", undefined);
			dispatcher.open(identity("stage-1", "run-warned"));
			dispatcher.deliver(stageWakeKey("run-warned", "stage-1"), ping("unread"));
			dispatcher.close(stageWakeKey("run-warned", "stage-1"));
			dispatcher.dispose();

			assert.equal(warn.mock.calls.length, 1);
			assert.deepEqual(warn.mock.calls[0], [
				"atomic-workflows: stage stage-1 of run run-warned ended with 1 unread wake message(s): test-ping",
			]);
		} finally {
			warn.mockRestore();
		}
	});

	test("cancelling a parked stage rejects its wait with the reason, and its later waits too, even with a message queued", async () => {
		const { dispatcher, reports } = recording();
		const waiting = entry("stage-1");
		dispatcher.register(waiting);
		const parked = dispatcher.park(waiting.wakeKey, "tool-results");
		const reason = new Error("stage aborted");

		dispatcher.cancel(waiting.wakeKey, reason);

		assert.deepEqual(await outcome(parked), { state: "rejected", reason });
		// A message that arrives after the cancel queues, but a cancelled stage does not take it.
		assert.deepEqual(dispatcher.deliver(waiting.wakeKey, toolResults("call-1")), { status: "queued" });
		assert.deepEqual(await outcome(dispatcher.park(waiting.wakeKey, "tool-results")), { state: "rejected", reason });
		// It is reported when the stage ends rather than dropped.
		dispatcher.close(waiting.wakeKey);
		assert.deepEqual(reports, [{ reason: "stage-ended", runId: RUN, stageId: "stage-1", kinds: ["tool-results"] }]);
		dispatcher.dispose();
	});

	test("cancelling a stage that is registered but not parked rejects its next park, and cancelling a stranger does nothing", async () => {
		const { dispatcher } = recording();
		const waiting = entry("stage-1");
		dispatcher.register(waiting);

		dispatcher.cancel(waiting.wakeKey, "stage closed");
		dispatcher.cancel(stageWakeKey(RUN, "stranger"), "ignored");

		assert.deepEqual(await outcome(dispatcher.park(waiting.wakeKey, "tool-results")), {
			state: "rejected",
			reason: "stage closed",
		});
		assert.equal(dispatcher.size, 1);
		dispatcher.dispose();
	});

	test("aborting the run rejects every parked stage with the abort reason and fails later parks of every open stage", async () => {
		const controller = new AbortController();
		const { dispatcher } = recording(RUN, controller.signal);
		const parkedStages = ["stage-1", "stage-2", "stage-3"].map((id) => entry(id));
		for (const waiting of parkedStages) dispatcher.register(waiting);
		const parked = parkedStages.map((waiting) => dispatcher.park(waiting.wakeKey, "tool-results"));
		const idle = entry("stage-4");
		dispatcher.register(idle);
		const resident = identity("stage-5");
		dispatcher.open(resident);
		const reason = new Error("workflow killed by the user");

		controller.abort(reason);

		for (const wait of parked) assert.deepEqual(await outcome(wait), { state: "rejected", reason });
		assert.deepEqual(await outcome(dispatcher.park(idle.wakeKey, "tool-results")), { state: "rejected", reason });
		assert.deepEqual(await outcome(dispatcher.park(resident.wakeKey, "tool-results")), { state: "rejected", reason });
		// The abort listener took itself off the signal, and the entries stay until their stages unregister.
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		assert.equal(dispatcher.size, 4);
		dispatcher.dispose();
	});

	test("an abort reason that is an Error, a DOMException or a string reaches the parked stage unchanged; anything else becomes a workflow-killed abort", async () => {
		const reasons: unknown[] = [
			new TypeError("plain error"),
			new DOMException("timed out", "TimeoutError"),
			"killed",
			42,
			null,
		];
		const seen: unknown[] = [];
		for (const reason of reasons) {
			const controller = new AbortController();
			const { dispatcher } = recording(RUN, controller.signal);
			const waiting = entry("stage-1");
			dispatcher.register(waiting);
			const parked = dispatcher.park(waiting.wakeKey, "tool-results");
			controller.abort(reason);
			const result = await outcome(parked);
			assert.equal(result.state, "rejected");
			seen.push(result.state === "rejected" ? result.reason : undefined);
			dispatcher.dispose();
		}

		assert.equal(seen[0], reasons[0]);
		assert.equal(seen[1], reasons[1]);
		assert.equal(seen[2], "killed");
		for (const fallback of [seen[3], seen[4]]) {
			assert.ok(fallback instanceof DOMException);
			assert.equal(fallback.name, "AbortError");
			assert.equal(fallback.message, "workflow killed");
		}
	});

	test("a run that was already aborted fails every park with its reason and keeps no listener on its signal", async () => {
		const reason = new Error("aborted before the stage parked");
		const signal = aborted(reason);
		const { dispatcher } = recording(RUN, signal);
		const waiting = entry("stage-1");
		dispatcher.register(waiting);
		assert.deepEqual(dispatcher.deliver(waiting.wakeKey, toolResults("call-1")), { status: "queued" });

		// Even a stage that is registered, with a message queued, and one that never opened.
		assert.deepEqual(await outcome(dispatcher.park(waiting.wakeKey, "tool-results")), { state: "rejected", reason });
		assert.deepEqual(await outcome(dispatcher.park(stageWakeKey(RUN, "stranger"), "tool-results")), {
			state: "rejected",
			reason,
		});
		assert.equal(getEventListeners(signal, "abort").length, 0);
		dispatcher.dispose();
	});

	test("one listener serves the whole run however many stages wait, and disposing the dispatcher takes it off the signal", () => {
		const controller = new AbortController();
		const { dispatcher } = recording(RUN, controller.signal);
		for (let index = 0; index < 50; index++) dispatcher.register(entry(`stage-${index}`));

		assert.equal(getEventListeners(controller.signal, "abort").length, 1);
		dispatcher.dispose();
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});

	test("a dispatcher without an abort signal can be disposed", () => {
		const { dispatcher } = recording();
		dispatcher.register(entry("stage-1"));

		assert.doesNotThrow(() => dispatcher.dispose());
	});

	test("a message sent by run and stage id reaches the live run's dispatcher, and says why it did not otherwise", async () => {
		const runId = "run-by-id";
		const { dispatcher } = recording(runId);
		const waiting = entry("stage-1", runId);
		dispatcher.register(waiting);
		const parked = dispatcher.park(waiting.wakeKey, "tool-results");
		const wake = toolResults("call-1");

		assert.deepEqual(deliverStageWake(runId, "stage-1", wake), { status: "delivered" });
		assert.deepEqual(await outcome(parked), { state: "resolved", value: wake });
		assert.deepEqual(deliverStageWake(runId, "stage-1", wake), { status: "queued" });
		assert.deepEqual(deliverStageWake(runId, "stranger", wake), { status: "stage-not-open" });
		assert.deepEqual(deliverStageWake("run-nobody-owns", "stage-1", wake), { status: "run-not-live" });

		dispatcher.dispose();
		assert.deepEqual(deliverStageWake(runId, "stage-1", wake), { status: "run-not-live" });
	});

	test("a disposed dispatcher leaves the run's route to the dispatcher that replaced it", () => {
		const runId = "run-replaced";
		const old = recording(runId).dispatcher;
		const current = recording(runId).dispatcher;
		const waiting = entry("stage-1", runId);
		old.register(waiting);
		current.register(waiting);

		old.dispose();
		assert.deepEqual(deliverStageWake(runId, "stage-1", toolResults("call-1")), { status: "queued" });
		assert.deepEqual(old.deliver(waiting.wakeKey, toolResults("call-2")), { status: "stage-not-open" });

		current.dispose();
		assert.deepEqual(deliverStageWake(runId, "stage-1", toolResults("call-3")), { status: "run-not-live" });
	});

	test("a message of a kind nobody registered is refused with StageWakeError and queues nothing", async () => {
		const { dispatcher, reports } = recording();
		const waiting = entry("stage-1");
		dispatcher.register(waiting);
		const parked = dispatcher.park(waiting.wakeKey, "test-unregistered");

		assert.throws(
			() => dispatcher.deliver(waiting.wakeKey, unregistered("lost")),
			(error: unknown) => {
				assert.ok(error instanceof StageWakeError);
				assert.ok(isStageWakeError(error));
				assert.equal(error.code, "unknown-wake-kind");
				assert.equal(error.retryable, false);
				assert.deepEqual(error.fields, { runId: RUN, stageId: "stage-1", kind: "test-unregistered" });
				return true;
			},
		);
		// Through the public entry point too, and for a run that is not live here.
		assert.throws(() => deliverStageWake(RUN, "stage-1", unregistered("lost")), StageWakeError);
		assert.throws(
			() => deliverStageWake("run-elsewhere", "stage-9", unregistered("lost")),
			(error: unknown) =>
				isStageWakeError(error) &&
				error.fields.runId === "run-elsewhere" &&
				error.fields.stageId === "stage-9" &&
				error.fields.kind === "test-unregistered",
		);

		assert.equal((await outcome(parked)).state, "pending");
		dispatcher.close(waiting.wakeKey);
		assert.deepEqual(reports, [], "nothing was queued, so nothing is reported");
		dispatcher.dispose();
	});

	test("a message of a kind with a handler runs the handler for its stage, resident or waiting, and says it was handled", async () => {
		const seen: { note: string; context: StageWakeHandlerContext }[] = [];
		const remove = registerStageWakeKind("test-handled", (wake, context) => {
			seen.push({ note: wake.note, context });
		});
		try {
			const controller = new AbortController();
			const { dispatcher } = recording(RUN, controller.signal);
			const stage = identity("stage-1");
			dispatcher.open(stage);

			assert.deepEqual(dispatcher.deliver(stage.wakeKey, handled("resident")), { status: "handled" });
			await settle();
			dispatcher.register(entry("stage-1", RUN, "release"));
			assert.deepEqual(deliverStageWake(RUN, "stage-1", handled("released")), { status: "handled" });
			await settle();

			assert.deepEqual(
				seen.map(({ note, context }) => [note, context.runId, context.stageId, context.waiting]),
				[
					["resident", RUN, "stage-1", undefined],
					["released", RUN, "stage-1", "release"],
				],
			);
			assert.ok(seen.every(({ context }) => context.signal === controller.signal));
			dispatcher.dispose();
		} finally {
			remove();
		}
	});

	test("a stage takes one message at a time: handlers run in arrival order, and a wake behind a handler waits for it", async () => {
		const log: string[] = [];
		const gates = new Map<string, PromiseWithResolvers<void>>();
		const remove = registerStageWakeKind("test-handled", async (wake) => {
			const gate = Promise.withResolvers<void>();
			gates.set(wake.note, gate);
			log.push(`start ${wake.note}`);
			await gate.promise;
			log.push(`end ${wake.note}`);
		});
		try {
			const { dispatcher } = recording();
			const waiting = entry("stage-1");
			const other = identity("stage-2");
			dispatcher.register(waiting);
			dispatcher.open(other);
			const parked = dispatcher.park(waiting.wakeKey, "tool-results");
			const results = toolResults("call-1");

			assert.deepEqual(dispatcher.deliver(waiting.wakeKey, handled("first")), { status: "handled" });
			assert.deepEqual(dispatcher.deliver(waiting.wakeKey, handled("second")), { status: "queued" });
			assert.deepEqual(dispatcher.deliver(waiting.wakeKey, results), { status: "queued" });
			// Another stage is not held up by this one's handler.
			assert.deepEqual(dispatcher.deliver(other.wakeKey, handled("elsewhere")), { status: "handled" });
			await settle();
			assert.deepEqual(log, ["start first", "start elsewhere"]);
			assert.equal((await outcome(parked)).state, "pending");

			gates.get("first")?.resolve();
			await settle();
			assert.deepEqual(log, ["start first", "start elsewhere", "end first", "start second"]);
			assert.equal((await outcome(parked)).state, "pending");

			gates.get("second")?.resolve();
			gates.get("elsewhere")?.resolve();
			assert.deepEqual(await outcome(parked), { state: "resolved", value: results });
			dispatcher.dispose();
		} finally {
			remove();
		}
	});

	test("a handler that throws or rejects is reported once, and its stage takes its next message", async () => {
		const log: string[] = [];
		const thrown = new Error("could not apply");
		const rejected = new Error("could not apply later");
		const remove = registerStageWakeKind("test-handled", async (wake) => {
			if (wake.note === "throws") throw thrown;
			await Promise.resolve();
			if (wake.note === "rejects") throw rejected;
			log.push(wake.note);
		});
		try {
			const { dispatcher, reports } = recording();
			const stage = identity("stage-1");
			dispatcher.open(stage);

			dispatcher.deliver(stage.wakeKey, handled("throws"));
			dispatcher.deliver(stage.wakeKey, handled("rejects"));
			dispatcher.deliver(stage.wakeKey, handled("works"));
			await settle();

			assert.deepEqual(log, ["works"]);
			assert.deepEqual(reports, [
				{ reason: "handler-failed", runId: RUN, stageId: "stage-1", kind: "test-handled", error: thrown },
				{ reason: "handler-failed", runId: RUN, stageId: "stage-1", kind: "test-handled", error: rejected },
			]);
			dispatcher.dispose();
		} finally {
			remove();
		}
	});

	test("the newest registration of a kind is in effect until removed, and the kind is known while any remains", async () => {
		const log: string[] = [];
		const removeFirst = registerStageWakeKind("test-handled", () => {
			log.push("first");
		});
		const removeSecond = registerStageWakeKind("test-handled", () => {
			log.push("second");
		});
		const { dispatcher } = recording();
		const stage = identity("stage-1");
		dispatcher.open(stage);

		dispatcher.deliver(stage.wakeKey, handled("a"));
		await settle();
		removeSecond();
		removeSecond();
		dispatcher.deliver(stage.wakeKey, handled("b"));
		await settle();
		removeFirst();

		assert.deepEqual(log, ["second", "first"]);
		assert.throws(() => dispatcher.deliver(stage.wakeKey, handled("c")), StageWakeError);
		dispatcher.dispose();
	});

	test("the built-in tool-results kind takes no handler (#4309)", () => {
		assert.throws(
			() => registerStageWakeKind("tool-results", (() => {}) as never),
			(error: unknown) => isStageWakeError(error) && error.code === "builtin-kind-handler",
		);
		const remove = registerStageWakeKind("tool-results");
		assert.equal(typeof remove, "function");
		remove();
	});

	test("watched detached calls deliver their results in call order once every call has settled", async () => {
		const { dispatcher } = recording();
		const waiting = entry("stage-1");
		dispatcher.register(waiting);
		const first = deferredCall("call-a");
		const second = deferredCall("call-b");
		dispatcher.watchToolResults(waiting.wakeKey, [first.call, second.call]);
		const parked = dispatcher.park(waiting.wakeKey, "tool-results");

		second.settle("b done");
		await settle();
		assert.equal((await outcome(parked)).state, "pending");
		first.settle("a done");

		assert.deepEqual(await outcome(parked), {
			state: "resolved",
			value: { kind: "tool-results", results: [toolResult("call-a", "a done"), toolResult("call-b", "b done")] },
		});
		dispatcher.dispose();
	});

	test("a watch of no calls delivers empty results at once, and results that arrive before the park queue for it", async () => {
		const { dispatcher } = recording();
		const stage = identity("stage-1");
		dispatcher.open(stage);

		dispatcher.watchToolResults(stage.wakeKey, []);
		assert.deepEqual(await outcome(dispatcher.park(stage.wakeKey, "tool-results")), {
			state: "resolved",
			value: { kind: "tool-results", results: [] },
		});

		const ci = deferredCall("call-1");
		dispatcher.watchToolResults(stage.wakeKey, [ci.call]);
		ci.settle();
		await settle();
		assert.deepEqual(await outcome(dispatcher.park(stage.wakeKey, "tool-results")), {
			state: "resolved",
			value: { kind: "tool-results", results: [toolResult("call-1")] },
		});
		dispatcher.dispose();
	});

	test("a new watch replaces one still outstanding, and late results of the calls it replaced are ignored", async () => {
		const { dispatcher, reports } = recording();
		const stage = identity("stage-1");
		dispatcher.open(stage);
		const replaced = deferredCall("call-1");
		dispatcher.watchToolResults(stage.wakeKey, [replaced.call]);
		// The same call dispatched again, as after a restart, under the same id.
		const current = deferredCall("call-1");
		dispatcher.watchToolResults(stage.wakeKey, [current.call]);
		const parked = dispatcher.park(stage.wakeKey, "tool-results");

		replaced.settle("stale");
		await settle();
		assert.equal((await outcome(parked)).state, "pending");
		current.settle("fresh");

		assert.deepEqual(await outcome(parked), {
			state: "resolved",
			value: { kind: "tool-results", results: [toolResult("call-1", "fresh")] },
		});
		dispatcher.close(stage.wakeKey);
		assert.deepEqual(reports, []);
		dispatcher.dispose();
	});

	test("a watched call whose result rejects fails the stage's wait with that error instead of waiting forever", async () => {
		const { dispatcher } = recording();
		const waiting = entry("stage-1");
		dispatcher.register(waiting);
		const broken = deferredCall("call-1");
		const fine = deferredCall("call-2");
		dispatcher.watchToolResults(waiting.wakeKey, [broken.call, fine.call]);
		const parked = dispatcher.park(waiting.wakeKey, "tool-results");
		const failure = new Error("the host broke its promise");

		broken.fail(failure);
		fine.settle();

		assert.deepEqual(await outcome(parked), { state: "rejected", reason: failure });
		dispatcher.dispose();
	});

	test("watching detached calls keeps none of the call objects alive, only their pending results", async () => {
		const collect = resolveCollect();
		const { dispatcher } = recording();
		const stage = identity("stage-1");
		dispatcher.open(stage);
		const pending = Promise.withResolvers<DetachedToolResult>();
		let watched: WeakRef<DetachedToolCall> | undefined;
		(() => {
			const call: DetachedToolCall = {
				toolCallId: "call-1",
				toolName: "wait_for_ci",
				result: pending.promise,
				abort() {},
			};
			watched = new WeakRef(call);
			dispatcher.watchToolResults(stage.wakeKey, [call]);
		})();

		// Collect without dereferencing in between: deref() keeps its target alive until the current job ends.
		for (let round = 0; round < 6; round++) {
			collect();
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		assert.equal(watched?.deref(), undefined);
		const parked = dispatcher.park(stage.wakeKey, "tool-results");
		pending.resolve(toolResult("call-1"));
		assert.deepEqual(await outcome(parked), {
			state: "resolved",
			value: { kind: "tool-results", results: [toolResult("call-1")] },
		});
		dispatcher.dispose();
	});
});

describe("StageAbortListeners (#4309)", () => {
	test("a listener added while attached runs when the signal aborts, once, and leaves nothing on the signal", () => {
		const controller = new AbortController();
		const listeners = new StageAbortListeners(controller.signal);
		let calls = 0;

		listeners.add(() => {
			calls += 1;
		});
		assert.equal(getEventListeners(controller.signal, "abort").length, 1);
		assert.equal(listeners.size, 1);
		controller.abort(new Error("stop"));

		assert.equal(calls, 1);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});

	test("a removed listener never runs and leaves the signal", () => {
		const controller = new AbortController();
		const listeners = new StageAbortListeners(controller.signal);
		let calls = 0;
		const remove = listeners.add(() => {
			calls += 1;
		});

		remove();

		assert.equal(listeners.size, 0);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		controller.abort();
		assert.equal(calls, 0);
	});

	test("race settles with the operation and takes its listener off the signal", async () => {
		const controller = new AbortController();
		const listeners = new StageAbortListeners(controller.signal);
		const operation = Promise.withResolvers<string>();

		const raced = listeners.race(operation.promise);
		assert.equal(listeners.size, 1);
		assert.equal(getEventListeners(controller.signal, "abort").length, 1);
		operation.resolve("done");

		assert.equal(await raced, "done");
		assert.equal(listeners.size, 0);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});

	test("race passes the operation's own failure through", async () => {
		const listeners = new StageAbortListeners(new AbortController().signal);
		const failure = new Error("the call failed");

		await assert.rejects(listeners.race(Promise.reject(failure)), (error) => error === failure);
		assert.equal(listeners.size, 0);
	});

	test("race rejects with the abort reason as soon as the signal aborts, while the operation is still running", async () => {
		const controller = new AbortController();
		const listeners = new StageAbortListeners(controller.signal);
		const operation = Promise.withResolvers<string>();
		const raced = listeners.race(operation.promise);
		const reason = new Error("workflow killed by the user");

		controller.abort(reason);

		await assert.rejects(raced, (error) => error === reason);
		assert.equal(listeners.size, 0);
		operation.resolve("late");
	});

	test("race on a signal that already aborted rejects with its reason even when the operation settled first, and still observes a late failure", async () => {
		const reason = new Error("aborted already");
		const listeners = new StageAbortListeners(aborted(reason));

		await assert.rejects(listeners.race(Promise.resolve("settled")), (error) => error === reason);

		const late = Promise.withResolvers<string>();
		const raced = listeners.race(late.promise);
		await assert.rejects(raced, (error) => error === reason);
		// Its failure after the race is handled: no unhandled rejection reaches the process.
		late.reject(new Error("failed after the abort"));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(listeners.size, 0);
	});

	test("race rejects with a workflow-killed abort when the signal carries no reason", async () => {
		const noReason = {
			aborted: true,
			reason: undefined,
			addEventListener() {},
			removeEventListener() {},
		} as unknown as AbortSignal;
		const listeners = new StageAbortListeners(noReason);

		await assert.rejects(listeners.race(new Promise<never>(() => {})), (error: unknown) => {
			assert.ok(error instanceof DOMException);
			assert.equal(error.name, "AbortError");
			assert.equal(error.message, "workflow killed");
			return true;
		});
	});

	test("detach takes every listener off the signal and an abort meanwhile runs none; attach puts them back", () => {
		const controller = new AbortController();
		const listeners = new StageAbortListeners(controller.signal);
		const calls: string[] = [];
		listeners.add(() => calls.push("one"));
		listeners.add(() => calls.push("two"));
		assert.equal(listeners.size, 2);

		listeners.detach();
		listeners.detach();
		assert.equal(listeners.size, 0);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);

		listeners.attach();
		listeners.attach();
		assert.equal(listeners.size, 2);
		assert.equal(getEventListeners(controller.signal, "abort").length, 2);
		controller.abort();

		assert.deepEqual(calls, ["one", "two"]);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});

	test("a listener added while detached waits for attach", () => {
		const controller = new AbortController();
		const listeners = new StageAbortListeners(controller.signal);
		let calls = 0;
		listeners.detach();

		listeners.add(() => {
			calls += 1;
		});
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		assert.equal(listeners.size, 0);
		listeners.attach();
		assert.equal(listeners.size, 1);
		controller.abort();

		assert.equal(calls, 1);
	});

	test("an abort while detached is delivered when the stage attaches again, once per listener", () => {
		const controller = new AbortController();
		const listeners = new StageAbortListeners(controller.signal);
		const calls: string[] = [];
		listeners.add(() => calls.push("one"));
		listeners.add(() => calls.push("two"));
		listeners.detach();
		controller.abort();
		assert.deepEqual(calls, []);

		listeners.attach();

		assert.deepEqual(calls, ["one", "two"]);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		// Attached already: attaching again delivers nothing more.
		listeners.attach();
		assert.deepEqual(calls, ["one", "two"]);
	});

	test("attaching a stage that never detached leaves its listeners alone", () => {
		const controller = new AbortController();
		const listeners = new StageAbortListeners(controller.signal);
		let calls = 0;
		listeners.add(() => {
			calls += 1;
		});
		controller.abort();
		assert.equal(calls, 1);

		listeners.attach();

		assert.equal(calls, 1);
	});
});

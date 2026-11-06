import { getEventListeners } from "node:events";
import type { DetachedToolCall, DetachedToolResult, ReleasedAgentSession } from "@bastani/atomic";
import { afterAll, afterEach, beforeAll, describe, vi } from "vitest";
import { countUiCalls, whileEvicted } from "../../packages/workflows/src/engine/run-eviction.js";
import {
	createToolControlRegistry,
	type WorkflowRunControlHandle,
} from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import {
	admitEvictedRun,
	EVICTION_RECHECK_MS,
	EvictedRun,
	evictedRun,
	type ResidentStage,
	type RunEvictionCheck,
	RunStageResidency,
	releaseEvictedRun,
	residentStageEntries,
} from "../../packages/workflows/src/runs/foreground/run-residency.js";
import {
	deliverStageWake,
	type EvictedToolWait,
	type StageToolWait,
	StageWakeDispatcher,
	type StageWakeReport,
	stageWakeKey,
} from "../../packages/workflows/src/runs/foreground/stage-wake-dispatcher.js";
import { isStageWakeError } from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { registerStageWakeKind, type StageWake } from "../../packages/workflows/src/shared/stage-wake.js";
import type { WorkflowUIContext } from "../../packages/workflows/src/shared/types.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { assert, createCancellationRegistry, test } from "./executor-shared.js";

useTemporaryAgentDir();

declare module "@bastani/atomic/workflows" {
	interface StageWakeKinds {
		/** Registered without a handler for this file: it queues for a stage's next wait of its kind. */
		"test-index-queued": { readonly note: string };
		/** Registered with a handler by the tests that need one. */
		"test-index-handled": { readonly note: string };
	}
}

function toolResult(toolCallId: string): DetachedToolResult {
	return {
		toolCallId,
		toolName: "wait_for_ci",
		result: { content: [{ type: "text", text: "ci passed" }], details: undefined },
		isError: false,
	};
}

interface ControlledCall {
	readonly call: DetachedToolCall;
	readonly settle: () => void;
	readonly fail: (error: Error) => void;
	readonly aborts: unknown[];
}

function controlledCall(toolCallId: string): ControlledCall {
	const result = Promise.withResolvers<DetachedToolResult>();
	const aborts: unknown[] = [];
	return {
		call: {
			toolCallId,
			toolName: "wait_for_ci",
			result: result.promise,
			abort: (reason) => {
				aborts.push(reason);
			},
		},
		settle: () => result.resolve(toolResult(toolCallId)),
		fail: (error) => result.reject(error),
		aborts,
	};
}

async function outcome<T>(promise: Promise<T>): Promise<"pending" | "resolved" | "rejected"> {
	const pending = Symbol("pending");
	const settled = await Promise.race([
		promise.then(
			() => "resolved" as const,
			() => "rejected" as const,
		),
		new Promise<typeof pending>((resolve) => setImmediate(() => resolve(pending))),
	]);
	return settled === pending ? "pending" : settled;
}

async function settle(): Promise<void> {
	for (let round = 0; round < 5; round++) await new Promise((resolve) => setImmediate(resolve));
}

function newRunId(): string {
	return crypto.randomUUID();
}

function stage(
	runId: string,
	stageId: string,
): { runId: string; stageId: string; wakeKey: string; replayKey?: string } {
	return { runId, stageId, wakeKey: stageWakeKey(runId, stageId), replayKey: `stage:${stageId}:1` };
}

function stageWithoutReplayKey(runId: string, stageId: string): ReturnType<typeof stage> {
	return { runId, stageId, wakeKey: stageWakeKey(runId, stageId) };
}

function recording(runId: string) {
	const reports: StageWakeReport[] = [];
	const dispatcher = new StageWakeDispatcher(runId, undefined, { report: (report) => reports.push(report) });
	return { dispatcher, reports };
}

/** A stage waiting released on `calls`, as `waitReleased` leaves it. */
function waitOnTool(dispatcher: StageWakeDispatcher, identity: ReturnType<typeof stage>, calls: DetachedToolCall[]) {
	dispatcher.open(identity);
	dispatcher.register({ ...identity, reason: "tool", since: 1_000 });
	dispatcher.watchToolResults(identity.wakeKey, calls);
	return dispatcher.park(identity.wakeKey, "tool-results");
}

function sessionOf(stageId: string): ReleasedAgentSession {
	return { sessionId: `session-${stageId}`, cwd: "/work" };
}

function waitingOn(calls: readonly DetachedToolCall[], stageId = "s"): StageToolWait {
	return { calls, session: sessionOf(stageId) };
}

function evictedWait(
	runId: string,
	stageId: string,
	calls: DetachedToolCall[],
	watchId = 0,
	settledCallIds: readonly string[] = [],
): EvictedToolWait {
	return {
		stageId,
		replayKey: `stage:${stageId}:1`,
		wakeKey: stageWakeKey(runId, stageId),
		since: 5,
		watchId,
		calls,
		settledCallIds,
		session: sessionOf(stageId),
	};
}

describe("a run's dispatcher hands its waits over when the run is evicted (#4373)", () => {
	let unregisterQueued: () => void = () => {};
	beforeAll(() => {
		unregisterQueued = registerStageWakeKind("test-index-queued");
	});
	afterAll(() => unregisterQueued());

	test("hands over each tool wait with its calls, settles nothing, stops routing the run, and keeps nothing (#4373)", async () => {
		const runId = newRunId();
		const { dispatcher } = recording(runId);
		const alpha = controlledCall("call-alpha");
		const idle = stage(runId, "idle");
		const parked = waitOnTool(dispatcher, stage(runId, "alpha"), [alpha.call]);
		dispatcher.open(idle);
		dispatcher.register({ ...idle, reason: "idle" });
		const released = stage(runId, "released");
		dispatcher.open(released);
		dispatcher.register({ ...released, reason: "release" });
		dispatcher.open(stage(runId, "fresh"));
		const waits = new Map([["alpha", waitingOn([alpha.call], "alpha")]]);

		const handoff = dispatcher.evict((stageId) => waits.get(stageId));

		assert.ok(handoff);
		assert.equal(handoff.waits.length, 1);
		const [wait] = handoff.waits;
		assert.deepEqual(
			{ ...wait, calls: wait!.calls.map((call) => call.toolCallId) },
			{
				stageId: "alpha",
				replayKey: "stage:alpha:1",
				wakeKey: stageWakeKey(runId, "alpha"),
				since: 1_000,
				watchId: wait!.watchId,
				calls: ["call-alpha"],
				settledCallIds: [],
				session: { sessionId: "session-alpha", cwd: "/work" },
			},
		);
		assert.equal(wait!.calls[0], alpha.call);
		assert.deepEqual([...handoff.wakes], []);
		assert.equal(dispatcher.evicted, true);
		assert.equal(dispatcher.size, 0);
		assert.deepEqual(dispatcher.entries(), []);
		assert.equal(await outcome(parked), "pending", "the parked wait is dropped, never settled");
		assert.deepEqual(deliverStageWake(runId, "alpha", { kind: "test-index-queued", note: "x" }), {
			status: "run-not-live",
		});
		dispatcher.dispose();
		assert.deepEqual(alpha.aborts, [], "the calls keep running");
	});

	test("a stage waiting without a watch, inline, or on anything but a tool keeps the run resident (#4373)", () => {
		const runId = newRunId();
		const call = controlledCall("call-1").call;
		const setups: Record<string, (dispatcher: StageWakeDispatcher) => void> = {
			"tool wait with no watch": (dispatcher) => {
				const identity = stage(runId, "s");
				dispatcher.open(identity);
				dispatcher.register({ ...identity, reason: "tool" });
			},
			"inline watch": (dispatcher) => {
				const identity = stage(runId, "s");
				dispatcher.open(identity);
				dispatcher.watchToolResults(identity.wakeKey, [call]);
			},
			"inline park": (dispatcher) => {
				const identity = stage(runId, "s");
				dispatcher.open(identity);
				void dispatcher.park(identity.wakeKey, "tool-results").catch(() => {});
			},
			"prompt wait": (dispatcher) => {
				const identity = stage(runId, "s");
				dispatcher.open(identity);
				dispatcher.register({ ...identity, reason: "prompt" });
			},
			"prompt wait with calls watched": (dispatcher) => {
				const identity = stage(runId, "s");
				dispatcher.open(identity);
				dispatcher.register({ ...identity, reason: "prompt" });
				dispatcher.watchToolResults(identity.wakeKey, [call]);
			},
			"no replay key": (dispatcher) => {
				void waitOnTool(dispatcher, stageWithoutReplayKey(runId, "s"), [call]).catch(() => {});
			},
			"calls not found": (dispatcher) => {
				void waitOnTool(dispatcher, stage(runId, "other"), [call]).catch(() => {});
			},
			cancelled: (dispatcher) => {
				void waitOnTool(dispatcher, stage(runId, "s"), [call]).catch(() => {});
				dispatcher.cancel(stageWakeKey(runId, "s"), "stage aborted");
			},
			"messages for a stage without a replay key": (dispatcher) => {
				const identity = stageWithoutReplayKey(runId, "s");
				dispatcher.open(identity);
				dispatcher.deliver(identity.wakeKey, { kind: "test-index-queued", note: "later" });
			},
		};
		for (const [name, setup] of Object.entries(setups)) {
			const { dispatcher } = recording(runId);
			setup(dispatcher);
			const before = { size: dispatcher.size, entries: dispatcher.entries() };
			assert.equal(
				dispatcher.evict((stageId) => (stageId === "s" ? waitingOn([call]) : undefined)),
				undefined,
				name,
			);
			assert.equal(dispatcher.evicted, false, name);
			assert.deepEqual({ size: dispatcher.size, entries: dispatcher.entries() }, before, name);
			dispatcher.dispose();
		}
	});

	test("a handler still running keeps the run resident until it settles (#4373)", async () => {
		const runId = newRunId();
		const gate = Promise.withResolvers<void>();
		const unregister = registerStageWakeKind("test-index-handled", () => gate.promise);
		try {
			const { dispatcher } = recording(runId);
			const identity = stage(runId, "s");
			dispatcher.open(identity);
			assert.deepEqual(dispatcher.deliver(identity.wakeKey, { kind: "test-index-handled", note: "x" }), {
				status: "handled",
			});
			await settle();
			assert.equal(
				dispatcher.evict(() => undefined),
				undefined,
			);
			assert.equal(dispatcher.evicted, false);
			gate.resolve();
			await settle();
			assert.ok(dispatcher.evict(() => undefined));
		} finally {
			unregister();
		}
	});

	test("messages queued for a stage are handed over by its replay key, and queue for it again once the rebuilt run opens it (#4373)", async () => {
		const runId = newRunId();
		const { dispatcher } = recording(runId);
		const identity = stage(runId, "s");
		dispatcher.open(identity);
		const first: StageWake = { kind: "test-index-queued", note: "first" };
		const second: StageWake = { kind: "test-index-queued", note: "second" };
		dispatcher.deliver(identity.wakeKey, first);
		dispatcher.deliver(identity.wakeKey, second);

		const handoff = dispatcher.evict(() => undefined);
		assert.ok(handoff);
		assert.deepEqual([...handoff.wakes], [["stage:s:1", { stageId: "s", wakes: [first, second] }]]);

		const rebuilt = recording(runId).dispatcher;
		const resumed = new StageWakeDispatcher(runId, undefined, { report: () => {} }, handoff);
		rebuilt.dispose();
		resumed.open(identity);
		resumed.open(identity);
		assert.deepEqual(await resumed.park(identity.wakeKey, "test-index-queued"), first);
		assert.deepEqual(await resumed.park(identity.wakeKey, "test-index-queued"), second);
		assert.equal(await outcome(resumed.park(identity.wakeKey, "test-index-queued")), "pending");
		resumed.dispose();
	});

	test("a rebuilt run's dispatcher hands each tool wait out once, lists those not taken, and aborts their calls when the run ends (#4373)", () => {
		const runId = newRunId();
		const alpha = controlledCall("call-alpha");
		const beta = controlledCall("call-beta");
		const reports: StageWakeReport[] = [];
		const pending: StageWake = { kind: "test-index-queued", note: "unread" };
		const dispatcher = new StageWakeDispatcher(
			runId,
			undefined,
			{ report: (report) => reports.push(report) },
			{
				waits: [evictedWait(runId, "alpha", [alpha.call]), evictedWait(runId, "beta", [beta.call])],
				wakes: new Map([["stage:gamma:1", { stageId: "gamma", wakes: [pending] }]]),
			},
		);
		assert.equal(dispatcher.holdsToolWaitForResume("stage:alpha:1"), true);
		assert.equal(dispatcher.holdsToolWaitForResume("stage:gamma:1"), false);
		assert.equal(dispatcher.takeToolWaitForResume("stage:alpha:1")?.calls[0], alpha.call);
		assert.equal(dispatcher.takeToolWaitForResume("stage:alpha:1"), undefined);
		assert.equal(dispatcher.holdsToolWaitForResume("stage:alpha:1"), false);
		assert.deepEqual(
			dispatcher.unadoptedToolWaits().map((wait) => wait.stageId),
			["beta"],
		);

		dispatcher.dispose();

		assert.deepEqual(alpha.aborts, []);
		assert.equal(beta.aborts.length, 1);
		const reason = beta.aborts[0] as DOMException;
		assert.equal(reason.name, "AbortError");
		assert.equal(
			reason.message,
			`atomic-workflows: run ${runId} ended before stage beta waited on its detached calls again`,
		);
		assert.deepEqual(dispatcher.unadoptedToolWaits(), []);
		assert.deepEqual(reports, [{ reason: "run-ended", runId, stageId: "gamma", kinds: ["test-index-queued"] }]);
	});

	test("waits handed over and not yet taken are handed over again when the rebuilt run is evicted (#4373)", () => {
		const runId = newRunId();
		const alpha = controlledCall("call-alpha");
		const wait = evictedWait(runId, "alpha", [alpha.call], 7);
		const pending = { stageId: "gamma", wakes: [{ kind: "test-index-queued", note: "x" } as StageWake] };
		const dispatcher = new StageWakeDispatcher(
			runId,
			undefined,
			{ report: () => {} },
			{ waits: [wait], wakes: new Map([["stage:gamma:1", pending]]) },
		);
		const handoff = dispatcher.evict(() => undefined);
		assert.deepEqual(handoff?.waits, [wait]);
		assert.deepEqual([...(handoff?.wakes ?? [])], [["stage:gamma:1", pending]]);
		assert.deepEqual(dispatcher.unadoptedToolWaits(), []);
		dispatcher.dispose();
		assert.deepEqual(alpha.aborts, []);
	});

	for (const order of [
		["call-alpha", "call-beta"],
		["call-beta", "call-alpha"],
	] as const)
		test(`a stage with a call settled before the run was evicted wakes the evicted run when its last call settles (${order[0]} first) (#4373)`, async () => {
			const runId = newRunId();
			const { dispatcher } = recording(runId);
			const calls = new Map([
				["call-alpha", controlledCall("call-alpha")],
				["call-beta", controlledCall("call-beta")],
			]);
			void waitOnTool(
				dispatcher,
				stage(runId, "alpha"),
				[...calls.values()].map(({ call }) => call),
			);
			calls.get(order[0])!.settle();
			await settle();

			const handoff = dispatcher.evict(() => waitingOn([...calls.values()].map(({ call }) => call)))!;
			assert.deepEqual(handoff.waits[0]!.settledCallIds, [order[0]]);
			const record = new EvictedRun(runId, handoff);
			admitEvictedRun(record);
			try {
				assert.deepEqual(record.stageEntries()[0]!.settledCallIds, [order[0]]);
				await settle();
				assert.equal(record.wokenBy, undefined, "one of two calls has a result");
				calls.get(order[1])!.settle();
				await settle();
				assert.equal(record.wokenBy, "tool-results");
				assert.deepEqual(record.stageEntries()[0]!.settledCallIds, [order[0], order[1]]);
				assert.deepEqual(record.handoff().waits[0]!.settledCallIds, [order[0], order[1]]);
			} finally {
				releaseEvictedRun(record);
			}
		});

	test("a result that arrives for a wait the rebuilt run has not taken yet is kept with the wait when that run is evicted (#4373)", async () => {
		const runId = newRunId();
		const first = recording(runId).dispatcher;
		const alpha = controlledCall("call-alpha");
		const beta = controlledCall("call-beta");
		void waitOnTool(first, stage(runId, "alpha"), [alpha.call, beta.call]);
		const handoff = first.evict(() => waitingOn([alpha.call, beta.call]))!;
		const rebuilt = recording(runId).dispatcher;
		for (const wait of handoff.waits) rebuilt.takeToolWaitForResume(wait.replayKey);
		const second = new StageWakeDispatcher(runId, undefined, { report: () => {} }, handoff);
		rebuilt.dispose();

		alpha.settle();
		await settle();
		const secondHandoff = second.evict(() => undefined)!;
		assert.deepEqual(secondHandoff.waits[0]!.settledCallIds, ["call-alpha"]);

		const record = new EvictedRun(runId, secondHandoff);
		admitEvictedRun(record);
		try {
			beta.settle();
			await settle();
			assert.equal(record.wokenBy, "tool-results");
		} finally {
			releaseEvictedRun(record);
		}
	});

	test("results kept for a wait the rebuilt run has not taken yet count once, and only for that wait's own watch and stage (#4373)", () => {
		const runId = newRunId();
		const alpha = controlledCall("call-alpha");
		const beta = controlledCall("call-beta");
		const handoff = { waits: [evictedWait(runId, "alpha", [alpha.call, beta.call], 7)], wakes: new Map() };
		const dispatcher = new StageWakeDispatcher(runId, undefined, { report: () => {} }, handoff);
		const wakeKey = stageWakeKey(runId, "alpha");

		dispatcher.toolResultSettled(wakeKey, 6, "call-beta", toolResult("call-beta"));
		dispatcher.toolResultSettled(stageWakeKey(runId, "other"), 7, "call-beta", toolResult("call-beta"));
		dispatcher.toolResultSettled(wakeKey, 7, "call-alpha", toolResult("call-alpha"));
		dispatcher.toolResultSettled(wakeKey, 7, "call-alpha", toolResult("call-alpha"));

		assert.deepEqual(dispatcher.evict(() => undefined)!.waits[0]!.settledCallIds, ["call-alpha"]);
	});

	test("a result that settles after the run was evicted reaches the run's eviction record, and each watch gets an id of its own (#4373)", async () => {
		const runId = newRunId();
		const { dispatcher } = recording(runId);
		const alpha = controlledCall("call-alpha");
		void waitOnTool(dispatcher, stage(runId, "alpha"), [alpha.call]);
		const other = recording(newRunId()).dispatcher;
		const otherIdentity = stage("other-run", "s");
		void waitOnTool(other, otherIdentity, [controlledCall("call-x").call]);
		const handoff = dispatcher.evict(() => waitingOn([alpha.call]))!;
		const otherWatch = other.evict(() => waitingOn([controlledCall("call-x").call]))!.waits[0]!.watchId;
		assert.notEqual(handoff.waits[0]!.watchId, otherWatch);
		const record = new EvictedRun(runId, handoff);
		admitEvictedRun(record);
		try {
			alpha.settle();
			await settle();
			assert.equal(record.wokenBy, "tool-results");
			assert.equal(await record.untilWoken(), "tool-results");
		} finally {
			releaseEvictedRun(record);
		}
	});
});

describe("a run's dispatcher once its run was evicted or rebuilt (#4373)", () => {
	let unregisterQueued: () => void = () => {};
	beforeAll(() => {
		unregisterQueued = registerStageWakeKind("test-index-queued");
	});
	afterAll(() => unregisterQueued());

	test("a result reaches the dispatcher that watched it while that dispatcher is not evicted, even when another took the run's route (#4373)", async () => {
		const runId = newRunId();
		const first = recording(runId).dispatcher;
		const alpha = controlledCall("call-alpha");
		const parked = waitOnTool(first, stage(runId, "alpha"), [alpha.call]);
		const second = recording(runId).dispatcher;
		alpha.settle();
		assert.equal(await outcome(parked), "resolved");
		second.dispose();
		first.dispose();
	});

	test("a result that settles when nothing routes the evicted run's wakes is dropped without an error (#4373)", async () => {
		const runId = newRunId();
		const { dispatcher } = recording(runId);
		const alpha = controlledCall("call-alpha");
		const beta = controlledCall("call-beta");
		void waitOnTool(dispatcher, stage(runId, "alpha"), [alpha.call, beta.call]);
		assert.ok(dispatcher.evict(() => waitingOn([alpha.call, beta.call])));
		const unhandled: unknown[] = [];
		const listen = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", listen);
		try {
			alpha.settle();
			beta.fail(new Error("the tool crashed"));
			await settle();
			await new Promise((resolve) => setTimeout(resolve, 10));
		} finally {
			process.off("unhandledRejection", listen);
		}
		assert.deepEqual(unhandled, []);
	});

	test("messages handed over for a stage run their handler as soon as its mailbox opens, and only once (#4373)", async () => {
		const runId = newRunId();
		const handled: string[] = [];
		const unregister = registerStageWakeKind("test-index-handled", (wake) => {
			handled.push(wake.note);
		});
		try {
			const identity = stage(runId, "s");
			const dispatcher = new StageWakeDispatcher(
				runId,
				undefined,
				{ report: () => {} },
				{
					waits: [],
					wakes: new Map([
						["stage:s:1", { stageId: "s", wakes: [{ kind: "test-index-handled", note: "while evicted" }] }],
					]),
				},
			);
			dispatcher.open(identity);
			await settle();
			assert.deepEqual(handled, ["while evicted"]);
			dispatcher.close(identity.wakeKey);
			dispatcher.open(identity);
			await settle();
			assert.deepEqual(handled, ["while evicted"]);
			dispatcher.dispose();
		} finally {
			unregister();
		}
	});

	test("an evicted dispatcher reports nothing it handed over when its run's execution ends, and a second disposal reports nothing again (#4373)", () => {
		const runId = newRunId();
		const reports: StageWakeReport[] = [];
		const pending = { stageId: "gamma", wakes: [{ kind: "test-index-queued", note: "x" } as StageWake] };
		const evicted = new StageWakeDispatcher(
			runId,
			undefined,
			{ report: (report) => reports.push(report) },
			{ waits: [], wakes: new Map([["stage:gamma:1", pending]]) },
		);
		assert.ok(evicted.evict(() => undefined));
		evicted.dispose();
		assert.equal(reports.length, 0);

		const ended = new StageWakeDispatcher(
			runId,
			undefined,
			{ report: (report) => reports.push(report) },
			{ waits: [], wakes: new Map([["stage:gamma:1", pending]]) },
		);
		ended.dispose();
		ended.dispose();
		assert.deepEqual(reports, [{ reason: "run-ended", runId, stageId: "gamma", kinds: ["test-index-queued"] }]);
	});
});

describe("an evicted run's record (#4373)", () => {
	let unregisterQueued: () => void = () => {};
	beforeAll(() => {
		unregisterQueued = registerStageWakeKind("test-index-queued");
	});
	afterAll(() => unregisterQueued());

	test("holds one plain entry per waiting stage, keeps the call handles beside them, and hands both back (#4373)", () => {
		const runId = newRunId();
		const alpha = controlledCall("call-alpha");
		const pending = { stageId: "gamma", wakes: [{ kind: "test-index-queued", note: "x" } as StageWake] };
		const record = new EvictedRun(runId, {
			waits: [evictedWait(runId, "alpha", [alpha.call], 3)],
			wakes: new Map([["stage:gamma:1", pending]]),
		});
		assert.deepEqual(record.stageEntries(), [
			{
				runId,
				stageId: "alpha",
				replayKey: "stage:alpha:1",
				reason: "tool",
				wakeKey: stageWakeKey(runId, "alpha"),
				since: 5,
				watchId: 3,
				toolCallIds: ["call-alpha"],
				settledCallIds: [],
				session: { sessionId: "session-alpha", cwd: "/work" },
			},
		]);
		const handoff = record.handoff();
		assert.deepEqual(handoff.waits, [evictedWait(runId, "alpha", [alpha.call], 3)]);
		assert.deepEqual([...handoff.wakes], [["stage:gamma:1", pending]]);
		assert.equal(record.wokenBy, undefined);
	});

	test("is found in the index only while admitted, and a release of another record leaves it (#4373)", () => {
		const runId = newRunId();
		const record = new EvictedRun(runId, { waits: [evictedWait(runId, "alpha", [])], wakes: new Map() });
		const stranger = new EvictedRun(runId, { waits: [], wakes: new Map() });
		admitEvictedRun(record);
		try {
			assert.equal(evictedRun(runId), record);
			assert.deepEqual(
				residentStageEntries().filter((entry) => entry.runId === runId),
				record.stageEntries(),
			);
			releaseEvictedRun(stranger);
			assert.equal(evictedRun(runId), record);
			assert.deepEqual(deliverStageWake(runId, "nobody", { kind: "test-index-queued", note: "x" }), {
				status: "stage-not-open",
			});
		} finally {
			releaseEvictedRun(record);
		}
		assert.equal(evictedRun(runId), undefined);
		assert.deepEqual(
			residentStageEntries().filter((entry) => entry.runId === runId),
			[],
		);
		assert.deepEqual(deliverStageWake(runId, "alpha", { kind: "test-index-queued", note: "x" }), {
			status: "run-not-live",
		});
	});

	test("queues messages for a waiting stage in order and wakes the run once; refuses an unknown kind or stage (#4373)", async () => {
		const runId = newRunId();
		const record = new EvictedRun(runId, {
			waits: [evictedWait(runId, "alpha", [controlledCall("call-alpha").call])],
			wakes: new Map(),
		});
		const wakeKey = stageWakeKey(runId, "alpha");
		assert.throws(
			() => record.deliver(wakeKey, { kind: "test-index-never-registered" as never, note: "x" }),
			(error: unknown) =>
				isStageWakeError(error) && error.fields.stageId === "alpha" && error.fields.runId === runId,
		);
		assert.throws(
			() => record.deliver(stageWakeKey(runId, "beta"), { kind: "test-index-never-registered" as never, note: "x" }),
			(error: unknown) => isStageWakeError(error) && error.fields.stageId === "beta",
		);
		assert.equal(record.wokenBy, undefined);
		assert.deepEqual(record.deliver(stageWakeKey(runId, "beta"), { kind: "test-index-queued", note: "x" }), {
			status: "stage-not-open",
		});
		assert.equal(record.wokenBy, undefined);
		const first: StageWake = { kind: "test-index-queued", note: "first" };
		const second: StageWake = { kind: "test-index-queued", note: "second" };
		assert.deepEqual(record.deliver(wakeKey, first), { status: "queued" });
		assert.deepEqual(record.deliver(wakeKey, second), { status: "queued" });
		assert.equal(record.wokenBy, "message");
		assert.equal(await record.untilWoken(), "message");
		assert.deepEqual([...record.handoff().wakes], [["stage:alpha:1", { stageId: "alpha", wakes: [first, second] }]]);
	});

	test("wakes once every call of a stage has a result from its own watch; other results and failures of other watches are ignored (#4373)", () => {
		const runId = newRunId();
		const wakeKey = stageWakeKey(runId, "alpha");
		const calls = [controlledCall("call-1").call, controlledCall("call-2").call, controlledCall("call-2").call];
		const record = new EvictedRun(runId, { waits: [evictedWait(runId, "alpha", calls, 9)], wakes: new Map() });
		record.toolResultSettled(wakeKey, 8, "call-1", toolResult("call-1"));
		record.toolResultSettled(wakeKey, 9, "call-3", toolResult("call-3"));
		record.toolResultSettled(stageWakeKey(runId, "beta"), 9, "call-1", toolResult("call-1"));
		record.toolResultFailed(wakeKey, 8, new Error("old watch"));
		record.toolResultFailed(stageWakeKey(runId, "beta"), 9, new Error("other stage"));
		record.toolResultSettled(wakeKey, 9, "call-1", toolResult("call-1"));
		record.toolResultSettled(wakeKey, 9, "call-1", toolResult("call-1"));
		assert.equal(record.wokenBy, undefined, "one of two distinct calls has a result");
		record.toolResultSettled(wakeKey, 9, "call-2", toolResult("call-2"));
		assert.equal(record.wokenBy, "tool-results");
		record.wake("control");
		assert.equal(record.wokenBy, "tool-results", "the first reason stays");
	});

	test("is woken at once when every call of a stage already has a result, and not while one of any stage lacks one (#4373)", () => {
		const runId = newRunId();
		const calls = (...ids: string[]) => ids.map((id) => controlledCall(id).call);
		const waiting = new EvictedRun(runId, {
			waits: [
				evictedWait(runId, "alpha", calls("call-1", "call-2"), 1, ["call-1"]),
				evictedWait(runId, "beta", calls("call-3"), 2),
			],
			wakes: new Map(),
		});
		assert.equal(waiting.wokenBy, undefined);
		const done = new EvictedRun(runId, {
			waits: [
				evictedWait(runId, "alpha", calls("call-1", "call-2"), 1, ["call-2", "call-1"]),
				evictedWait(runId, "beta", calls("call-3"), 2),
			],
			wakes: new Map(),
		});
		assert.equal(done.wokenBy, "tool-results");
	});

	test("a result for a call the stage does not wait on, or one it already has, changes nothing in its entry (#4373)", () => {
		const runId = newRunId();
		const wakeKey = stageWakeKey(runId, "alpha");
		const record = new EvictedRun(runId, {
			waits: [
				evictedWait(runId, "alpha", [controlledCall("call-1").call, controlledCall("call-2").call], 9, ["call-1"]),
			],
			wakes: new Map(),
		});
		const before = structuredClone(record.stageEntries());
		record.toolResultSettled(wakeKey, 9, "call-1", toolResult("call-1"));
		record.toolResultSettled(wakeKey, 9, "call-3", toolResult("call-3"));
		record.toolResultSettled(wakeKey, 8, "call-2", toolResult("call-2"));
		assert.deepEqual(record.stageEntries(), before);
		assert.equal(record.wokenBy, undefined);
	});

	test("a call whose result rejected wakes the run, so the rebuilt stage meets the rejection (#4373)", () => {
		const runId = newRunId();
		const record = new EvictedRun(runId, {
			waits: [evictedWait(runId, "alpha", [controlledCall("call-1").call], 4)],
			wakes: new Map(),
		});
		record.toolResultFailed(stageWakeKey(runId, "alpha"), 4, new Error("tool crashed"));
		assert.equal(record.wokenBy, "tool-results");
	});
});

describe("a run's live stages as its eviction sees them (#4373)", () => {
	function resident(state: ReturnType<ResidentStage["evictionState"]>, evictions: string[], name: string) {
		const calls = [controlledCall(`call-${name}`).call];
		return {
			evictionState: () => state,
			waitingOn: () => (state === "waiting-on-tool" ? waitingOn(calls, name) : undefined),
			evict: () => evictions.push(name),
		} satisfies ResidentStage;
	}

	test("waits on tools while every stage waits on one or holds nothing and one waits, is busy while any stage is, and waits on nothing otherwise (#4373)", () => {
		const evictions: string[] = [];
		const cases: [ReturnType<ResidentStage["evictionState"]>[], ReturnType<RunStageResidency["waits"]>][] = [
			[[], "none"],
			[["passive"], "none"],
			[["waiting-on-tool"], "tools"],
			[["passive", "waiting-on-tool", "passive"], "tools"],
			[["waiting-on-tool", "busy"], "busy"],
			[["busy", "waiting-on-tool"], "busy"],
			[["passive", "busy"], "busy"],
		];
		for (const [states, expected] of cases) {
			const residency = new RunStageResidency(0, () => "settled");
			for (const [index, state] of states.entries())
				residency.add(`s${index}`, resident(state, evictions, `s${index}`));
			assert.equal(residency.waits(), expected, JSON.stringify(states));
		}
	});

	test("finds a stage's calls, evicts every stage once, and forgets them (#4373)", () => {
		const evictions: string[] = [];
		const residency = new RunStageResidency(0, () => "settled");
		const waiting = resident("waiting-on-tool", evictions, "a");
		residency.add("a", waiting);
		residency.add("b", resident("passive", evictions, "b"));
		assert.deepEqual(residency.waitingOn("a"), waiting.waitingOn());
		assert.equal(residency.waitingOn("a")?.calls, waiting.waitingOn()?.calls);
		assert.equal(residency.waitingOn("b"), undefined);
		assert.equal(residency.waitingOn("missing"), undefined);
		residency.evict();
		residency.evict();
		assert.deepEqual(evictions, ["a", "b"]);
		assert.equal(residency.waits(), "none");
	});

	test("decides once the run has been quiet for afterMs, every change starting the quiet period again, and never after it stopped (#4373)", () => {
		vi.useFakeTimers();
		try {
			let quiet = 0;
			const residency = new RunStageResidency(30, (checked) => {
				assert.equal(checked, residency);
				quiet += 1;
				return "settled";
			});
			residency.changed();
			vi.advanceTimersByTime(15);
			residency.changed();
			vi.advanceTimersByTime(29);
			assert.equal(quiet, 0, "a change restarted the quiet period");
			vi.advanceTimersByTime(1);
			assert.equal(quiet, 1);
			residency.changed();
			residency.stop();
			vi.advanceTimersByTime(100);
			assert.equal(quiet, 1);
			residency.changed();
			residency.evict();
			vi.advanceTimersByTime(100);
			assert.equal(quiet, 1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("a run found busy beside its waiting stages (#4373)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("is checked again after the recheck period until its check evicts or settles it, and not after that (#4373)", () => {
		vi.useFakeTimers();
		const outcomes: RunEvictionCheck[] = ["busy", "busy", "evicted", "busy"];
		let checks = 0;
		const residency = new RunStageResidency(0, () => {
			checks += 1;
			return outcomes.shift()!;
		});
		residency.changed();
		vi.advanceTimersByTime(0);
		assert.equal(checks, 1);
		vi.advanceTimersByTime(EVICTION_RECHECK_MS - 1);
		assert.equal(checks, 1, "a busy run waits the recheck period");
		vi.advanceTimersByTime(1);
		assert.equal(checks, 2);
		vi.advanceTimersByTime(EVICTION_RECHECK_MS);
		assert.equal(checks, 3);
		vi.advanceTimersByTime(10 * EVICTION_RECHECK_MS);
		assert.equal(checks, 3, "an evicted run is not checked again");
		assert.equal(EVICTION_RECHECK_MS, 1_000);
	});

	test("a run whose check settles is not checked again until a stage changes (#4373)", () => {
		vi.useFakeTimers();
		let checks = 0;
		const residency = new RunStageResidency(5, () => {
			checks += 1;
			return "settled";
		});
		residency.changed();
		vi.advanceTimersByTime(10 * EVICTION_RECHECK_MS);
		assert.equal(checks, 1);
		residency.changed();
		vi.advanceTimersByTime(5);
		assert.equal(checks, 2);
	});

	test("a longer quiet period than the recheck period is waited before each check again (#4373)", () => {
		vi.useFakeTimers();
		let checks = 0;
		const residency = new RunStageResidency(1_200, () => {
			checks += 1;
			return "busy";
		});
		residency.changed();
		vi.advanceTimersByTime(1_200);
		assert.equal(checks, 1);
		vi.advanceTimersByTime(1_199);
		assert.equal(checks, 1, "the next check waits the run's own longer period");
		vi.advanceTimersByTime(1);
		assert.equal(checks, 2);
		residency.stop();
		vi.advanceTimersByTime(10_000);
		assert.equal(checks, 2);
	});
});

describe("an evicted run's owner (#4373)", () => {
	test("its controls wake the run and reach the rebuilt run's controls once it started (#4373)", async () => {
		const toolControls = createToolControlRegistry();
		const runId = newRunId();
		for (const operation of ["pause", "resume", "quit"] as const) {
			const record = new EvictedRun(runId, { waits: [], wakes: new Map() });
			admitEvictedRun(record);
			const woken = whileEvicted(record, { runId, toolControls });
			const control = toolControls.runControl(runId)!;
			assert.equal(control.paused, false);
			const sent = control[operation]();
			const wake = await woken;
			assert.equal(record.wokenBy, "control");
			assert.equal(evictedRun(runId), undefined);
			assert.equal(toolControls.runControl(runId), undefined, "the evicted run's control is gone");
			const reached: string[] = [];
			const live: WorkflowRunControlHandle = {
				paused: false,
				pause: async () => void reached.push("pause"),
				resume: async () => void reached.push("resume"),
				quit: async () => void reached.push("quit"),
			};
			const unregister = toolControls.registerRun(runId, live);
			wake.rebuilt();
			await sent;
			assert.deepEqual(reached, [operation]);
			unregister();
		}
	});

	test("a control sent when nothing took the run's place reaches nothing (#4373)", async () => {
		const toolControls = createToolControlRegistry();
		const runId = newRunId();
		const record = new EvictedRun(runId, { waits: [], wakes: new Map() });
		const woken = whileEvicted(record, { runId, toolControls });
		const sent = toolControls.runControl(runId)!.pause();
		(await woken).rebuilt();
		await sent;
		assert.equal(toolControls.runControl(runId), undefined);
	});

	test("a caller signal aborted already, or later, wakes the run, and the handoff carries the stages' waits (#4373)", async () => {
		const toolControls = createToolControlRegistry();
		const runId = newRunId();
		const wait = evictedWait(runId, "alpha", [controlledCall("call-1").call]);
		const aborted = new AbortController();
		aborted.abort();
		const record = new EvictedRun(runId, { waits: [wait], wakes: new Map() });
		const wake = await whileEvicted(record, { runId, toolControls, signal: aborted.signal });
		assert.equal(record.wokenBy, "control");
		assert.deepEqual(wake.handoff.waits, [wait]);

		const later = new AbortController();
		const second = new EvictedRun(runId, { waits: [], wakes: new Map() });
		const woken = whileEvicted(second, { runId, toolControls, signal: later.signal });
		await settle();
		assert.equal(second.wokenBy, undefined);
		assert.equal(getEventListeners(later.signal, "abort").length, 1);
		later.abort();
		await woken;
		assert.equal(second.wokenBy, "control");

		const kept = new AbortController();
		const third = new EvictedRun(runId, { waits: [], wakes: new Map() });
		const thirdWoken = whileEvicted(third, { runId, toolControls, signal: kept.signal });
		third.wake("tool-results");
		await thirdWoken;
		assert.equal(
			getEventListeners(kept.signal, "abort").length,
			0,
			"the caller's signal keeps no listener of the run",
		);
	});

	test("a kill through the cancellation registry wakes the run and kills what started in its place (#4373)", async () => {
		const toolControls = createToolControlRegistry();
		const cancellation = createCancellationRegistry();
		const runId = newRunId();
		const record = new EvictedRun(runId, { waits: [], wakes: new Map() });
		const woken = whileEvicted(record, { runId, toolControls, cancellation });
		const reason = new Error("killed");
		assert.equal(cancellation.abort(runId, reason), true);
		const wake = await woken;
		assert.equal(record.wokenBy, "control");
		const rebuilt = new AbortController();
		cancellation.register(runId, rebuilt);
		wake.rebuilt();
		assert.equal(rebuilt.signal.aborted, true);
		assert.equal(rebuilt.signal.reason, reason);

		const quiet = new EvictedRun(runId, { waits: [], wakes: new Map() });
		const quietWake = whileEvicted(quiet, { runId, toolControls, cancellation });
		quiet.wake("tool-results");
		const next = new AbortController();
		cancellation.unregister(runId);
		cancellation.register(runId, next);
		(await quietWake).rebuilt();
		assert.equal(next.signal.aborted, false, "a run woken by its results is not killed");
	});

	test("counts the run's ui calls in flight until each settles, however it settles (#4373)", async () => {
		const gates = Array.from({ length: 5 }, () => Promise.withResolvers<never>());
		const ui = {
			input: () => gates[0]!.promise,
			confirm: () => gates[1]!.promise,
			select: () => gates[2]!.promise,
			editor: () => gates[3]!.promise,
			custom: () => gates[4]!.promise,
		} as unknown as WorkflowUIContext;
		const inFlight = { count: 0 };
		const counted = countUiCalls(ui, inFlight);
		const calls = [
			counted.input("a"),
			counted.confirm("b"),
			counted.select("c", ["x"]),
			counted.editor("d"),
			counted.custom(() => ({ render: () => [], invalidate: () => {} }) as never),
		];
		assert.equal(inFlight.count, 5);
		gates[0]!.resolve("typed" as never);
		gates[1]!.reject(new Error("dismissed"));
		await settle();
		assert.equal(inFlight.count, 3);
		assert.equal(await calls[0], "typed");
		await assert.rejects(calls[1]!, /dismissed/);
		for (const gate of gates.slice(2)) gate.resolve("done" as never);
		await Promise.all(calls.slice(2));
		assert.equal(inFlight.count, 0);
	});
});

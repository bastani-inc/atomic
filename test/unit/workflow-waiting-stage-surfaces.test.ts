import { getEventListeners } from "node:events";
import { afterEach, describe, test, vi } from "vitest";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { recordStageSessionCheckpoint } from "../../packages/workflows/src/durable/stage-primitive.js";
import { durableStageCheckpointMetadata } from "../../packages/workflows/src/durable/stage-topology.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { deferStageUntilRunRelease } from "../../packages/workflows/src/engine/run-paused-stage.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { settleResumeAcknowledgements } from "../../packages/workflows/src/runs/background/resume-acknowledgements.js";
import { pauseRun } from "../../packages/workflows/src/runs/background/status.js";
import {
	createStageControlRegistry,
	type StageControlHandle,
	type StageControlStatus,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { StageArtifactCapture } from "../../packages/workflows/src/runs/foreground/stage-runner-artifact-capture.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { STAGE_SESSION_HEARTBEAT_INTERVAL_MS } from "../../packages/workflows/src/runs/foreground/stage-session-heartbeat.js";
import type { StageWaitSnapshot } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { workflowObservationRuntime } from "../../packages/workflows/src/shared/store-factory.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { StageContext } from "../../packages/workflows/src/shared/types.js";
import { workflowActivityNodeKey } from "../../packages/workflows/src/shared/workflow-activity.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { renderHeader } from "../../packages/workflows/src/tui/header.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { assert, mockSession, run, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService, TOOL } from "./waiting-stage-helpers.js";

const RUN_ID = "run-surfaces";
/**
 * Structural cost: these tests drive a run through release and wake under fake timers, with a polled wait loop and a
 * step per heartbeat interval; the run machinery, not the assertions, sets the time.
 */
const FAKE_TIMER_RELEASE_TEST_TIMEOUT_MS = 60_000;
const WAIT: StageWaitSnapshot = {
	kind: "tool",
	since: 1_000,
	toolCalls: [{ toolCallId: "call-1", toolName: "wait_for_ci" }],
};

function stage(id: string, status: StageSnapshot["status"], patch: Partial<StageSnapshot> = {}): StageSnapshot {
	return { id, name: id, status, parentIds: [], toolEvents: [], ...patch };
}

function runOf(stages: StageSnapshot[], patch: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages,
		startedAt: 1,
		...patch,
	};
}

interface FakeHandle {
	readonly handle: StageControlHandle;
	readonly calls: { pause: number; resume: number };
	setStatus(status: StageControlStatus): void;
}

/** A stage control handle whose `pause()` pauses it and whose `resume()` runs `onResume`. */
function fakeHandle(
	runId: string,
	stageId: string,
	initial: StageControlStatus,
	onResume: (set: (status: StageControlStatus) => void) => Promise<undefined> = async (set) => {
		set("running");
		return undefined;
	},
): FakeHandle {
	let status = initial;
	const calls = { pause: 0, resume: 0 };
	const set = (next: StageControlStatus): void => {
		status = next;
	};
	const handle: StageControlHandle = {
		runId,
		stageId,
		stageName: stageId,
		get status() {
			return status;
		},
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: false,
		messages: [],
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		async pause() {
			calls.pause += 1;
			status = "paused";
		},
		async resume() {
			calls.resume += 1;
			return onResume(set);
		},
		subscribe: () => () => {},
	};
	return { handle, calls, setStatus: set };
}

describe("run-level pause reaches waiting stages (#4309)", () => {
	test("the run's control pauses stages that are running, pending or waiting, and no others", async () => {
		const registry = createStageControlRegistry();
		const statuses: StageControlStatus[] = [
			"running",
			"pending",
			"waiting",
			"awaiting_input",
			"blocked",
			"completed",
			"failed",
			"skipped",
		];
		const fakes = statuses.map((status) => fakeHandle(RUN_ID, `s-${status}`, status));
		for (const { handle } of fakes) registry.register(handle);

		const changed = await registry.run(RUN_ID).pause();

		assert.deepEqual(
			fakes.map(({ calls }) => calls.pause),
			[1, 1, 1, 0, 0, 0, 0, 0],
		);
		assert.deepEqual(changed.map((handle) => handle.stageId).sort(), ["s-pending", "s-running", "s-waiting"]);
	});

	test("pausing a run through /workflow pause pauses its waiting stage and marks the run paused", async () => {
		const store = createStore();
		const waiting = stage("s-waiting", "waiting", { wait: WAIT });
		store.recordRunStart(runOf([waiting]));
		const registry = createStageControlRegistry();
		const fake = fakeHandle(RUN_ID, "s-waiting", "waiting");
		registry.register(fake.handle);

		const result = await pauseRun(RUN_ID, { store, stageControlRegistry: registry });

		assert.equal(result.ok, true);
		assert.equal(fake.calls.pause, 1);
		assert.deepEqual(result.ok ? result.paused.map((paused) => [paused.id, paused.status]) : [], [
			["s-waiting", "paused"],
		]);
		assert.equal(store.run(RUN_ID)?.status, "paused");
		assert.equal(store.run(RUN_ID)?.stages[0]?.status, "paused");
	});

	test("a run whose only live stages are pending or running is paused the same way, and ended stages are left alone", async () => {
		for (const status of ["running", "pending"] as const) {
			const store = createStore();
			store.recordRunStart(runOf([stage("live", status), stage("done", "completed")]));
			const registry = createStageControlRegistry();
			const live = fakeHandle(RUN_ID, "live", status);
			const done = fakeHandle(RUN_ID, "done", "completed");
			registry.register(live.handle);
			registry.register(done.handle);

			const result = await pauseRun(RUN_ID, { store, stageControlRegistry: registry });

			assert.equal(result.ok, true, status);
			assert.deepEqual([live.calls.pause, done.calls.pause], [1, 0], status);
		}
	});

	test("a run with nothing but ended stages has nothing to pause", async () => {
		const store = createStore();
		store.recordRunStart(runOf([stage("done", "completed")]));
		const registry = createStageControlRegistry();
		const done = fakeHandle(RUN_ID, "done", "completed");
		registry.register(done.handle);

		const result = await pauseRun(RUN_ID, { store, stageControlRegistry: registry });

		assert.deepEqual(result, { ok: false, runId: RUN_ID, reason: "no_active_stages" });
		assert.equal(done.calls.pause, 0);
	});

	test("pausing one stage leaves the run running while another stage still runs, is pending or waits", async () => {
		for (const sibling of ["running", "pending", "waiting"] as const) {
			const store = createStore();
			store.recordRunStart(runOf([stage("target", "running"), stage("sibling", sibling)]));
			const registry = createStageControlRegistry();
			const target = fakeHandle(RUN_ID, "target", "running");
			registry.register(target.handle);

			const result = await pauseRun(RUN_ID, { store, stageControlRegistry: registry, stageId: "target" });

			assert.equal(result.ok, true, sibling);
			assert.equal(
				store.run(RUN_ID)?.stages.find((candidate) => candidate.id === "target")?.status,
				"paused",
				sibling,
			);
			assert.equal(store.run(RUN_ID)?.status, "running", `a ${sibling} sibling keeps the run running`);
		}
	});

	test("pausing the last live stage pauses the run, whatever ended or paused around it", async () => {
		for (const sibling of ["completed", "failed", "skipped", "paused"] as const) {
			const store = createStore();
			store.recordRunStart(runOf([stage("target", "running"), stage("sibling", sibling)]));
			const registry = createStageControlRegistry();
			registry.register(fakeHandle(RUN_ID, "target", "running").handle);

			const result = await pauseRun(RUN_ID, { store, stageControlRegistry: registry, stageId: "target" });

			assert.equal(result.ok, true, sibling);
			assert.equal(store.run(RUN_ID)?.status, "paused", `a ${sibling} sibling does not keep the run running`);
		}
	});
});

describe("resume acknowledgements count a stage that is visibly back to work (#4309)", () => {
	function pausedStore(patch: Partial<StageSnapshot> = {}) {
		const store = createStore();
		const target = stage("s1", "running", { startedAt: 1, ...patch });
		store.recordRunStart(runOf([target]));
		store.recordStagePaused(RUN_ID, "s1");
		return { store, target };
	}

	test("a resume that failed counts as acknowledged when the stage is visibly running, pending, awaiting input or waiting", async () => {
		for (const visible of ["running", "pending", "awaiting_input", "waiting"] as const) {
			const { store } = pausedStore(visible === "waiting" ? { wait: WAIT } : {});
			const fake = fakeHandle(RUN_ID, "s1", "paused", async (set) => {
				set(visible);
				throw new Error("resume refused");
			});
			fake.setStatus("paused");

			const result = await settleResumeAcknowledgements(store, [{ controlRunId: RUN_ID, handle: fake.handle }]);

			assert.equal(result.acknowledged, 1, visible);
			assert.deepEqual(result.failures, [], visible);
			// The stage is no longer paused in the store either: waiting again if it still waits, running otherwise.
			assert.equal(store.run(RUN_ID)?.stages[0]?.status, visible === "waiting" ? "waiting" : "running", visible);
		}
	});

	test("a resume that failed and left the stage paused is a failure to retry, not an acknowledgement", async () => {
		const { store } = pausedStore();
		const fake = fakeHandle(RUN_ID, "s1", "paused", async () => {
			throw new Error("resume refused");
		});

		const result = await settleResumeAcknowledgements(store, [{ controlRunId: RUN_ID, handle: fake.handle }]);

		assert.equal(result.acknowledged, 0);
		assert.deepEqual(result.failures, [`${RUN_ID}/s1: resume refused`]);
		assert.equal(store.run(RUN_ID)?.stages[0]?.status, "paused");
	});

	test("a stage that was resumed is acknowledged and reported as resumed once it runs", async () => {
		const { store } = pausedStore();
		const fake = fakeHandle(RUN_ID, "s1", "paused");

		const result = await settleResumeAcknowledgements(store, [{ controlRunId: RUN_ID, handle: fake.handle }]);

		assert.equal(result.acknowledged, 1);
		assert.deepEqual(
			result.resumed.map((resumed) => resumed.id),
			["s1"],
		);
	});
});

describe("a stage waiting with its session released in the store (#4309)", () => {
	function liveStore() {
		const store = createStore();
		workflowObservationRuntime(store).startRun(RUN_ID);
		return { store, executing: workflowObservationRuntime(store).executingStageIds };
	}
	const key = workflowActivityNodeKey(RUN_ID, "s1");

	test("a waiting stage is no longer executing, and a running one is", () => {
		const { store, executing } = liveStore();
		const target = stage("s1", "running");
		store.recordRunStart(runOf([target]));
		store.recordStageStart(RUN_ID, target);
		assert.equal(executing.has(key), true);

		target.status = "waiting";
		target.wait = WAIT;
		store.recordStageStart(RUN_ID, target);
		assert.equal(executing.has(key), false);

		target.status = "running";
		delete target.wait;
		store.recordStageStart(RUN_ID, target);
		assert.equal(executing.has(key), true);
	});

	test("recording a stage that is neither running nor waiting does not change whether it executes", () => {
		const { store, executing } = liveStore();
		const target = stage("s1", "running");
		store.recordRunStart(runOf([target]));
		store.recordStageStart(RUN_ID, target);
		target.status = "awaiting_input";
		store.recordStageStart(RUN_ID, target);
		assert.equal(executing.has(key), true, "only a waiting stage stops executing when it is recorded");
	});

	test("a waiting stage that was paused returns to waiting when resumed, still not executing", () => {
		const { store, executing } = liveStore();
		const target = stage("s1", "running", { startedAt: 1 });
		store.recordRunStart(runOf([target]));
		store.recordStageStart(RUN_ID, target);
		target.status = "waiting";
		target.wait = WAIT;
		store.recordStageStart(RUN_ID, target);
		assert.equal(store.recordStagePaused(RUN_ID, "s1"), true);
		assert.equal(store.run(RUN_ID)?.stages[0]?.status, "paused");

		assert.equal(store.recordStageResumed(RUN_ID, "s1"), true);

		assert.equal(store.run(RUN_ID)?.stages[0]?.status, "waiting");
		assert.equal(executing.has(key), false);
	});

	test("a stage that was paused while running runs again when resumed, and executes on a live run only", () => {
		for (const live of [true, false]) {
			const store = createStore();
			if (live) workflowObservationRuntime(store).startRun(RUN_ID);
			const target = stage("s1", "running", { startedAt: 1 });
			store.recordRunStart(runOf([target]));
			store.recordStagePaused(RUN_ID, "s1");
			assert.equal(workflowObservationRuntime(store).executingStageIds.has(key), false);

			assert.equal(store.recordStageResumed(RUN_ID, "s1"), true);

			assert.equal(store.run(RUN_ID)?.stages[0]?.status, "running");
			assert.equal(workflowObservationRuntime(store).executingStageIds.has(key), live, `live run: ${live}`);
		}
	});

	test("a waiting stage resumed on a run that is not live does not execute either", () => {
		const store = createStore();
		const target = stage("s1", "waiting", { startedAt: 1, wait: WAIT });
		store.recordRunStart(runOf([target]));
		store.recordStagePaused(RUN_ID, "s1");
		store.recordStageResumed(RUN_ID, "s1");
		assert.equal(store.run(RUN_ID)?.stages[0]?.status, "waiting");
		assert.equal(workflowObservationRuntime(store).executingStageIds.has(key), false);
	});
});

describe("the run header counts waiting stages (#4309)", () => {
	const theme = deriveGraphTheme({});
	const plain = (lines: readonly string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	const header = (stages: StageSnapshot[]) => plain(renderHeader(runOf(stages), { theme, width: 100 }));

	test("a badge counts the stages waiting, apart from running and pending ones", () => {
		const text = header([
			stage("a", "waiting", { wait: WAIT }),
			stage("b", "waiting", { wait: WAIT }),
			stage("c", "running"),
			stage("d", "pending"),
		]);
		assert.match(text, /◷ 2/);
		assert.match(text, /● 1/);
		assert.match(text, /○ 1/);
	});

	test("a single waiting stage shows its count, and no stage waiting shows no badge", () => {
		assert.match(header([stage("a", "waiting", { wait: WAIT })]), /◷ 1/);
		const none = header([stage("a", "running"), stage("b", "completed")]);
		assert.equal(none.includes("◷"), false);
		assert.equal(header([]).includes("◷"), false);
	});

	test("the waiting badge is drawn in the dim color, as the pending badge is, and not as a running one", () => {
		const colored = renderHeader(
			runOf([stage("a", "waiting", { wait: WAIT }), stage("b", "pending"), stage("c", "running")]),
			{ theme, width: 100 },
		).join("\n");
		const colorOf = (label: string): string | undefined =>
			new RegExp(`((?:\\x1b\\[[0-9;]*m)+)${label}`).exec(colored)?.[1];
		assert.ok(colorOf("◷ 1") !== undefined);
		assert.equal(colorOf("◷ 1"), colorOf("○ 1"));
		assert.notEqual(colorOf("◷ 1"), colorOf("● 1"));
	});
});

describe("a stage's wait is checkpointed durably (#4309)", () => {
	const WORKFLOW_ID = "wf-wait-checkpoints";

	async function deps() {
		const backend = await JournalTestBackend.create();
		await backend.commitWorkflowRegistration({
			workflowId: WORKFLOW_ID,
			name: "wait-test",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		let next = 0;
		return {
			backend,
			deps: {
				workflowId: WORKFLOW_ID,
				backend,
				nextCheckpointId: () => `checkpoint-${++next}`,
				nextReplayKey: () => "stage:analyze:1",
				now: () => 5_000,
			},
		};
	}

	test("the checkpoint carries the wait only while the stage waits", () => {
		const waiting = stage("s1", "waiting", { wait: WAIT, sessionId: "sid-1" });
		assert.deepEqual(durableStageCheckpointMetadata(waiting).wait, WAIT);
		const running = stage("s1", "running", { sessionId: "sid-1" });
		assert.equal("wait" in durableStageCheckpointMetadata(running), false);
	});

	test("each wait of a stage is a checkpoint of its own, apart from the stage's other session checkpoints", async () => {
		const { backend, deps: stageDeps } = await deps();
		const base = { replayKey: "stage:analyze:1", sessionId: "sid-1", startedAt: 1_000 };
		const running = stage("s1", "running", base);
		const first = stage("s1", "waiting", { ...base, wait: { kind: "release", since: 2_000 } });
		const second = stage("s1", "waiting", { ...base, wait: { kind: "release", since: 3_000 } });

		for (const snapshot of [running, first, second, first]) {
			await recordStageSessionCheckpoint(stageDeps, snapshot, { force: true });
		}

		const checkpoints = backend.listCheckpoints(WORKFLOW_ID);
		// The same wait recorded twice is one checkpoint; a running stage and each distinct wait are three.
		assert.equal(checkpoints.length, 3);
		assert.deepEqual(
			checkpoints
				.map((checkpoint) => (checkpoint.kind === "stage" ? (checkpoint.wait?.since ?? 0) : -1))
				.sort((left, right) => left - right),
			[0, 2_000, 3_000],
		);
	});

	test("a stage context deferred by a paused run forwards release, rehydrate and readMessages once the run is released", async () => {
		const calls: string[] = [];
		const stored = [{ role: "user", content: "plan", timestamp: 1 }];
		const real = {
			release: async () => void calls.push("release"),
			rehydrate: async () => void calls.push("rehydrate"),
			readMessages: async () => {
				calls.push("readMessages");
				return stored;
			},
		} as unknown as StageContext;
		let paused = true;
		const waiters: (() => void)[] = [];
		const deferred = deferStageUntilRunRelease({
			name: "implement",
			create: () => real,
			isPaused: () => paused,
			waitForRelease: () => new Promise<void>((resolve) => waiters.push(resolve)),
			signal: new AbortController().signal,
		});

		const released = deferred.release();
		const rehydrated = deferred.rehydrate();
		const read = deferred.readMessages();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(calls, [], "none runs while the run is paused");

		paused = false;
		for (const resolve of waiters.splice(0)) resolve();
		await Promise.all([released, rehydrated]);
		assert.equal(await read, stored);
		assert.deepEqual(calls.sort(), ["readMessages", "rehydrate", "release"]);
	});
});

describe("answers captured for an output artifact (#4309)", () => {
	function session(messages: StageSessionRuntime["messages"]): StageSessionRuntime {
		return { messages } as unknown as StageSessionRuntime;
	}
	const answer = (text: string) =>
		({
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
		}) as unknown as StageSessionRuntime["messages"][number];

	test("a generation captures the answers of its session by default", () => {
		const capture = new StageArtifactCapture();
		capture.reset();
		const messages: StageSessionRuntime["messages"] = [];
		capture.beginAttempt(session(messages));
		messages.push(answer("first"));
		capture.settleAttempt(true);
		assert.deepEqual(
			capture.messages().map((message) => (message as { content: { text: string }[] }).content[0]?.text),
			["first"],
		);
	});

	test("a generation that writes no artifact keeps no answers", () => {
		const capture = new StageArtifactCapture();
		capture.reset(false);
		const messages: StageSessionRuntime["messages"] = [];
		capture.beginAttempt(session(messages));
		messages.push(answer("first"));
		capture.settleAttempt(true);
		assert.deepEqual(capture.messages(), []);
	});

	test("answers produced before the session is released are kept, and nothing of the session itself", () => {
		const capture = new StageArtifactCapture();
		capture.reset();
		const messages: StageSessionRuntime["messages"] = [];
		const live = session(messages);
		capture.beginAttempt(live);
		// The adapter exposes the answer without emitting an event, so only a scan sees it.
		messages.push(answer("before release"));

		capture.releaseSession();
		capture.settleAttempt(true);

		assert.deepEqual(
			capture.messages().map((message) => (message as { content: { text: string }[] }).content[0]?.text),
			["before release"],
		);
	});
});

async function until(predicate: () => boolean): Promise<void> {
	for (let round = 0; round < 2_000 && !predicate(); round++) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(predicate(), "condition never held");
}

async function settleTicks(rounds = 50): Promise<void> {
	for (let round = 0; round < rounds; round++) await new Promise((resolve) => setImmediate(resolve));
}

/** Fails instead of hanging the suite when `promise` does not settle in time. */
async function within<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

type DetachingAdapters = ReturnType<typeof detachingAdapters>;

/** The same adapters, with every session they create passed to `wrap` before the stage sees it. */
function wrapSessions(base: DetachingAdapters, wrap: (session: StageSessionRuntime) => void): DetachingAdapters {
	const agentSession = base.agentSession!;
	return {
		...base,
		agentSession: {
			async create(options, meta) {
				const created = (await agentSession.create(options, meta)) as StageSessionRuntime;
				wrap(created);
				return created;
			},
		},
	};
}

/** Counts the stage turns running at once, and holds each one until `hold` (when set) settles. */
function trackTurns(base: DetachingAdapters, tracker: { active: number; peak: number; hold?: Promise<void> }) {
	return wrapSessions(base, (session) => {
		for (const method of ["prompt", "resumeDetachedTurn"] as const) {
			const original = (session[method] as (...args: never[]) => Promise<void>).bind(session);
			Object.assign(session, {
				[method]: async (...args: never[]) => {
					tracker.active += 1;
					tracker.peak = Math.max(tracker.peak, tracker.active);
					try {
						await tracker.hold;
						return await original(...args);
					} finally {
						tracker.active -= 1;
					}
				},
			});
		}
	});
}

function stageNamed(store: ReturnType<typeof createStore>, name: string): StageSnapshot | undefined {
	return store.runs()[0]?.stages.find((candidate) => candidate.name === name);
}

describe("a stage that waits reports it through the SDK (#4309)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	test("its snapshot, durable checkpoint, events and execution ownership follow the wait", async () => {
		const service = new FakeCiService();
		const seen = counters();
		const store = createStore();
		const resumeGate = Promise.withResolvers<void>();
		const checkpoints: { status: string; wait: string | undefined; forceDurable: boolean | undefined }[] = [];
		const events: unknown[] = [];
		let waiting: { status?: string; wait?: StageWaitSnapshot; executing: boolean } | undefined;
		let continuing: { status?: string; wait?: StageWaitSnapshot; executing: boolean } | undefined;
		let stageId = "";
		const adapters = wrapSessions(detachingAdapters(service, seen), (session) => {
			const resume = session.resumeDetachedTurn!.bind(session);
			session.resumeDetachedTurn = async (results) => {
				await resumeGate.promise;
				return resume(results);
			};
		});
		const definition = workflow({
			name: "wait-report",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const task = ctx.task("implement", { prompt: "write the change" });
				await until(() => stageNamed(store, "implement")?.status === "waiting");
				const snapshot = stageNamed(store, "implement")!;
				stageId = snapshot.id;
				const executing = workflowObservationRuntime(store).executingStageIds;
				const key = workflowActivityNodeKey(store.runs()[0]!.id, snapshot.id);
				waiting = { status: snapshot.status, wait: snapshot.wait, executing: executing.has(key) };
				await new Promise((resolve) => setTimeout(resolve, 40));
				service.finishAll();
				await until(() => snapshot.status === "running");
				continuing = { status: snapshot.status, wait: snapshot.wait, executing: executing.has(key) };
				resumeGate.resolve();
				await task;
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				releaseWhenWaiting: { afterMs: 0 },
				adapters,
				onStageSession: (_runId, snapshot, options) => {
					checkpoints.push({
						status: snapshot.status,
						wait: snapshot.wait?.kind,
						forceDurable: options?.forceDurable,
					});
				},
				onStageLifecycleEvent: (_runId, event) => events.push(event),
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.equal(waiting?.status, "waiting");
		assert.equal(waiting?.wait?.kind, "tool");
		assert.deepEqual(waiting?.wait?.toolCalls, [{ toolCallId: "call-implement", toolName: TOOL }]);
		assert.equal(waiting?.executing, false, "a waiting stage executes nothing");
		// The wait is checkpointed durably, and forced, the moment the stage starts waiting.
		assert.deepEqual(
			checkpoints.find((checkpoint) => checkpoint.status === "waiting"),
			{ status: "waiting", wait: "tool", forceDurable: true },
		);
		assert.equal(continuing?.status, "running");
		assert.equal(continuing?.wait, undefined);
		assert.equal(continuing?.executing, true, "a woken stage executes again");
		const [waitingEvent, rehydratedEvent] = events as [
			{ type: string; stageId: string; stageName: string; wait: StageWaitSnapshot },
			{ type: string; stageId: string; stageName: string; wait: StageWaitSnapshot; waitedMs: number },
		];
		assert.equal(events.length, 2);
		assert.deepEqual(
			[waitingEvent.type, waitingEvent.stageId, waitingEvent.stageName],
			["stage_waiting", stageId, "implement"],
		);
		assert.deepEqual(waitingEvent.wait, waiting?.wait);
		assert.deepEqual(
			[rehydratedEvent.type, rehydratedEvent.stageId, rehydratedEvent.stageName],
			["stage_rehydrated", stageId, "implement"],
		);
		assert.deepEqual(rehydratedEvent.wait, waiting?.wait);
		// The stage was held waiting for at least 40 ms of the test's making.
		assert.ok(rehydratedEvent.waitedMs >= 30, `waited ${rehydratedEvent.waitedMs} ms`);
		assert.ok(rehydratedEvent.waitedMs < 60_000, `waited ${rehydratedEvent.waitedMs} ms`);
	});

	test("a lifecycle listener that throws or rejects is reported and does not fail the run", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const service = new FakeCiService();
		const seen = counters();
		const store = createStore();
		const definition = workflow({
			name: "listener-failures",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const task = ctx.task("implement", { prompt: "write the change" });
				await until(() => stageNamed(store, "implement")?.status === "waiting");
				service.finishAll();
				await task;
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				releaseWhenWaiting: { afterMs: 0 },
				adapters: detachingAdapters(service, seen),
				onStageLifecycleEvent: (_runId, event) => {
					if (event.type === "stage_waiting") throw new Error("listener threw");
					return Promise.reject(new Error("listener rejected"));
				},
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(
			error.mock.calls.map(([message, reported]) => [message, (reported as Error).message]),
			[
				["atomic-workflows: onStageLifecycleEvent listener failed on stage_waiting", "listener threw"],
				["atomic-workflows: onStageLifecycleEvent listener failed on stage_rehydrated", "listener rejected"],
			],
		);
	});

	test("a run without a lifecycle listener reports nothing", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const service = new FakeCiService();
		const seen = counters();
		const store = createStore();
		const definition = workflow({
			name: "no-listener",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const task = ctx.task("implement", { prompt: "write the change" });
				await until(() => stageNamed(store, "implement")?.status === "waiting");
				service.finishAll();
				await task;
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{ store, releaseWhenWaiting: { afterMs: 0 }, adapters: detachingAdapters(service, seen) },
		);

		assert.equal(result.status, "completed", result.error);
		assert.equal(error.mock.calls.length, 0);
	});

	test("a run whose sessions cannot be reopened keeps its stages resident and says so once", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let runId = "";
		const definition = workflow({
			name: "resident",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const first = ctx.stage("first");
				const second = ctx.stage("second");
				await Promise.all([first.prompt("one"), second.prompt("two")]);
				return {};
			},
		});
		const store = createStore();

		const result = await run(
			definition,
			{},
			{
				store,
				// A session with no store behind it can be detached from but not reopened.
				adapters: { agentSession: { create: async () => ({ ...mockSession(), setToolDetachment() {} }) } },
			},
		);
		runId = store.runs()[0]!.id;

		assert.equal(result.status, "completed", result.error);
		assert.equal(warn.mock.calls.length, 1);
		assert.match(
			String(warn.mock.calls[0]?.[0]),
			new RegExp(
				`^atomic-workflows: run ${runId} keeps waiting stages resident: Cannot release stage "first": its session cannot be reopened from a store \\(not-reopenable\\)\\.`,
			),
		);
	});

	test("a run whose sessions can be reopened says nothing about residency", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const service = new FakeCiService();
		const seen = counters();
		const definition = workflow({
			name: "not-resident",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("only").prompt("go");
				return {};
			},
		});

		await run(
			definition,
			{},
			{ store: createStore(), adapters: detachingAdapters(service, seen, { detach: false }) },
		);

		assert.equal(warn.mock.calls.length, 0);
	});

	test(
		"a waiting stage keeps no durability heartbeat, and a woken stage starts one again",
		async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const service = new FakeCiService();
			const seen = counters();
			const store = createStore();
			const resumeGate = Promise.withResolvers<void>();
			let checkpointsWhileWaiting = -1;
			let checkpointsAfterWake = -1;
			let checkpoints = 0;
			const adapters = wrapSessions(detachingAdapters(service, seen), (session) => {
				const resume = session.resumeDetachedTurn!.bind(session);
				session.resumeDetachedTurn = async (results) => {
					await resumeGate.promise;
					return resume(results);
				};
			});
			const definition = workflow({
				name: "heartbeat",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const task = ctx.task("implement", { prompt: "write the change" });
					await until(() => stageNamed(store, "implement")?.status === "waiting");
					const before = checkpoints;
					await vi.advanceTimersByTimeAsync(STAGE_SESSION_HEARTBEAT_INTERVAL_MS * 3 + 100);
					checkpointsWhileWaiting = checkpoints - before;
					service.finishAll();
					await until(() => stageNamed(store, "implement")?.status === "running");
					const afterWake = checkpoints;
					await vi.advanceTimersByTimeAsync(STAGE_SESSION_HEARTBEAT_INTERVAL_MS + 100);
					checkpointsAfterWake = checkpoints - afterWake;
					resumeGate.resolve();
					await task;
					return {};
				},
			});

			const result = await run(
				definition,
				{},
				{
					store,
					releaseWhenWaiting: { afterMs: 0 },
					adapters,
					onStageSession: () => {
						checkpoints += 1;
					},
				},
			);

			assert.equal(result.status, "completed", result.error);
			assert.equal(checkpointsWhileWaiting, 0, "no checkpoint is written for a stage that only waits");
			assert.ok(checkpointsAfterWake >= 1, "a stage that runs again is checkpointed on its interval");
		},
		FAKE_TIMER_RELEASE_TEST_TIMEOUT_MS,
	);
});

describe("waiting stages and the run's admission slots (#4309)", () => {
	test("a woken stage takes an admission slot again before it continues", async () => {
		const STAGES = 6;
		const CONCURRENCY = 2;
		const service = new FakeCiService();
		const seen = counters();
		const store = createStore();
		const tracker: { active: number; peak: number; hold?: Promise<void> } = { active: 0, peak: 0 };
		const gate = Promise.withResolvers<void>();
		let peakAfterWake = 0;
		const definition = workflow({
			name: "wake-admission",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const tasks = Array.from({ length: STAGES }, (_, index) => ctx.task(`stage-${index}`, { prompt: "go" }));
				await until(() => store.runs()[0]?.stages.filter((stage) => stage.status === "waiting").length === STAGES);
				tracker.peak = 0;
				tracker.hold = gate.promise;
				service.finishAll();
				// The woken stages queue for their slots; wait for the first to be admitted, then give any extra a chance.
				await until(() => tracker.peak >= 1);
				await settleTicks(100);
				peakAfterWake = tracker.peak;
				gate.resolve();
				await Promise.all(tasks);
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				config: { defaultConcurrency: CONCURRENCY } as never,
				releaseWhenWaiting: { afterMs: 0 },
				adapters: trackTurns(detachingAdapters(service, seen), tracker),
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.equal(peakAfterWake, CONCURRENCY, `${peakAfterWake} continuations ran at once of ${STAGES} woken stages`);
	});

	test("releasing a stage between prompts does not hand out a slot it never held", async () => {
		const service = new FakeCiService();
		const seen = counters();
		const store = createStore();
		const tracker: { active: number; peak: number; hold?: Promise<void> } = { active: 0, peak: 0 };
		let peakWhileHeld = 0;
		const definition = workflow({
			name: "release-admission",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const first = ctx.stage("first");
				await first.prompt("go");
				await first.release();
				const gate = Promise.withResolvers<void>();
				tracker.hold = gate.promise;
				tracker.peak = 0;
				const turns = Promise.all([ctx.stage("second").prompt("go"), ctx.stage("third").prompt("go")]);
				await until(() => tracker.peak >= 1);
				await settleTicks();
				peakWhileHeld = tracker.peak;
				gate.resolve();
				await turns;
				await first.rehydrate();
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				config: { defaultConcurrency: 1 } as never,
				adapters: trackTurns(detachingAdapters(service, seen, { detach: false }), tracker),
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.equal(peakWhileHeld, 1, "one slot admits one turn at a time, before and after a release");
	});

	test(
		"a waiting stage that is aborted does not hand back the slot it already gave up",
		async () => {
			const service = new FakeCiService();
			const seen = counters();
			const store = createStore();
			const tracker: { active: number; peak: number; hold?: Promise<void> } = { active: 0, peak: 0 };
			let aborted: string | undefined;
			let peakWhileHeld = 0;
			const definition = workflow({
				name: "abort-admission",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const first = ctx.stage("first");
					const turn = first.prompt("go");
					await until(() => stageNamed(store, "first")?.status === "waiting");
					await first.abort();
					try {
						await turn;
					} catch (error) {
						aborted = (error as Error).message;
					}
					const gate = Promise.withResolvers<void>();
					tracker.hold = gate.promise;
					tracker.peak = 0;
					const turns = Promise.allSettled([ctx.stage("second").prompt("go"), ctx.stage("third").prompt("go")]);
					await until(() => tracker.peak >= 1);
					await settleTicks();
					peakWhileHeld = tracker.peak;
					gate.resolve();
					// The later stages call the same fake tool; answer it until they are done.
					for (let round = 0; round < 300; round++) {
						service.finishAll();
						await settleTicks(1);
					}
					await turns;
					return {};
				},
			});

			const result = await run(
				definition,
				{},
				{
					store,
					config: { defaultConcurrency: 1 } as never,
					releaseWhenWaiting: { afterMs: 0 },
					adapters: trackTurns(detachingAdapters(service, seen), tracker),
				},
			);

			assert.equal(result.status, "completed", result.error);
			assert.equal(aborted, "stage aborted");
			assert.equal(peakWhileHeld, 1, "the aborted stage returned its slot once, not twice");
		},
		FAKE_TIMER_RELEASE_TEST_TIMEOUT_MS,
	);

	test("sequential tasks leave no abort listener behind on the run", async () => {
		const service = new FakeCiService();
		const seen = counters();
		const listeners: number[] = [];
		const definition = workflow({
			name: "listener-hygiene",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				for (let index = 0; index < 5; index++) {
					await ctx.task(`task-${index}`, { prompt: "go" });
					await settleTicks(20);
					listeners.push(getEventListeners(seen.runSignal!, "abort").length);
				}
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{ store: createStore(), adapters: detachingAdapters(service, seen, { detach: false }) },
		);

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(new Set(listeners).size, 1, `listeners on the run after each task: ${listeners.join(", ")}`);
	});
});

describe("author and host controls of a released stage (#4309)", () => {
	afterEach(() => vi.restoreAllMocks());

	test("a released stage still reports its session id, and one that never had a session says so", async () => {
		const service = new FakeCiService();
		const seen = counters();
		let refused: string | undefined;
		let before: string | undefined;
		let released: string | undefined;
		const definition = workflow({
			name: "released-session-id",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("implement");
				try {
					stage.sessionId;
				} catch (error) {
					refused = (error as Error).message;
				}
				await stage.prompt("go");
				before = stage.sessionId;
				await stage.release();
				released = stage.sessionId;
				await stage.rehydrate();
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{ store: createStore(), adapters: detachingAdapters(service, seen, { detach: false }) },
		);

		assert.equal(result.status, "completed", result.error);
		assert.match(refused ?? "", /property "sessionId" is unavailable until the SDK session has been created/);
		assert.equal(typeof before, "string");
		assert.equal(released, before);
	});

	test("attaching a released stage's handle does not reopen it, and attaching a fresh stage creates its session", async () => {
		const service = new FakeCiService();
		const seen = counters();
		const registry = createStageControlRegistry();
		const store = createStore();
		let createdByFreshAttach = -1;
		let createdByReleasedAttach = -1;
		const definition = workflow({
			name: "attach-released",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("implement", { releaseWhenWaiting: true });
				const handle = registry.forRun(store.runs()[0]!.id)[0]!;
				await handle.ensureAttached();
				createdByFreshAttach = seen.created;
				await stage.prompt("go");
				await stage.release();
				const before = seen.created;
				await within(handle.ensureAttached());
				createdByReleasedAttach = seen.created - before;
				await stage.rehydrate();
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				stageControlRegistry: registry,
				adapters: detachingAdapters(service, seen, { detach: false }),
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.equal(createdByFreshAttach, 1);
		assert.equal(createdByReleasedAttach, 0);
		await registry.clear();
	});

	test("text with delivery options sent to a waiting stage is held until it reopens, and reaches a resident one at once", async () => {
		const service = new FakeCiService();
		const seen = counters();
		const registry = createStageControlRegistry();
		const store = createStore();
		let queuedWhileWaiting: string[] = [];
		let queuedWhileResident: string[] = [];
		const definition = workflow({
			name: "held-text",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const waiting = ctx.task("waiting", { prompt: "go" });
				const resident = ctx.task("resident", { prompt: "go", releaseWhenWaiting: false });
				await until(() => stageNamed(store, "waiting")?.status === "waiting" && service.pending.size === 2);
				const handles = registry.forRun(store.runs()[0]!.id);
				const waitingHandle = handles.find((handle) => handle.stageName === "waiting")!;
				const residentHandle = handles.find((handle) => handle.stageName === "resident")!;
				await within(waitingHandle.steer("to the waiting stage", { expandPromptTemplates: false }));
				await within(waitingHandle.followUp("then summarize", { expandPromptTemplates: false }));
				await within(residentHandle.steer("to the resident stage", { expandPromptTemplates: false }));
				queuedWhileWaiting = [...seen.queued];
				service.finishAll();
				await Promise.all([waiting, resident]);
				queuedWhileResident = [...seen.queued];
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				stageControlRegistry: registry,
				releaseWhenWaiting: { afterMs: 0 },
				adapters: detachingAdapters(service, seen),
			},
		);

		assert.equal(result.status, "completed", result.error);
		// Only the resident stage had a session to take the text; the waiting stage's text was held.
		assert.deepEqual(queuedWhileWaiting, ["resident: steer to the resident stage"]);
		assert.deepEqual(queuedWhileResident, [
			"resident: steer to the resident stage",
			"waiting: steer to the waiting stage",
			"waiting: followUp then summarize",
		]);
		await registry.clear();
	});

	test("release and rehydrate are refused once the run is aborted, and release leaves the session alone", async () => {
		const service = new FakeCiService();
		const seen = counters();
		const controller = new AbortController();
		let release: string | undefined;
		let rehydrate: string | undefined;
		let liveAfter = -1;
		const definition = workflow({
			name: "aborted-release",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("implement");
				await stage.prompt("go");
				controller.abort(new Error("stop the run"));
				try {
					await stage.release();
				} catch (error) {
					release = (error as Error).message;
				}
				try {
					await stage.rehydrate();
				} catch (error) {
					rehydrate = (error as Error).message;
				}
				liveAfter = seen.created - seen.disposed;
				return {};
			},
		});

		await run(
			definition,
			{},
			{
				store: createStore(),
				signal: controller.signal,
				adapters: detachingAdapters(service, seen, { detach: false }),
			},
		);

		assert.equal(release, "stop the run");
		assert.equal(rehydrate, "stop the run");
		assert.equal(liveAfter, 1, "the refused release did not dispose the stage's session");
	});
});

describe("Intercom reaches a waiting stage through the run's route bridge (#4309)", () => {
	const BRIDGE_RUN_ID = "4ac72924-c452-4e5f-9e63-2435722109f7";
	const GROUP = `workflow:${BRIDGE_RUN_ID}`;

	afterEach(() => setDurableBackend(undefined));

	async function bridge(stagePatch: Partial<StageSnapshot>) {
		const store = createStore();
		store.recordRunStart({
			id: BRIDGE_RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [
				{
					id: "reviewer-id",
					name: "reviewer",
					status: "pending",
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: true,
					...stagePatch,
				},
			],
			startedAt: 1,
		});
		const durable = await createMemoryTestBackend();
		await durable.commitWorkflowRegistration({
			workflowId: BRIDGE_RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		bindStoreDurableBackend(store, durable);
		const listeners = new Map<string, (payload: unknown) => void>();
		const emitted: { event: string; payload: Record<string, unknown> }[] = [];
		const dispose = registerPendingStageIntercomBridge(
			{
				events: {
					emit(event: string, payload: Record<string, unknown>) {
						emitted.push({ event, payload });
						listeners.get(event)?.(payload);
					},
					on(event: string, listener: (payload: unknown) => void) {
						listeners.set(event, listener);
						return () => listeners.delete(event);
					},
				},
			},
			store,
		);
		dispose.refresh();
		const roster = (): { readonly lifecycle: string; readonly routeEligible: boolean }[] => {
			const announcement = emitted.findLast(({ event }) => event === "atomic:workflow-pending-stage-route");
			assert.ok(announcement, "the bridge announces the run's route roster");
			return (announcement.payload as { stages: { lifecycle: string; routeEligible: boolean }[] }).stages;
		};
		const send = async (live?: boolean) => {
			const payload = {
				handled: false,
				requestId: "request-1",
				from: {
					id: "sender-id",
					name: "planner",
					cwd: "/repo",
					model: "test-model",
					pid: 10,
					startedAt: 11,
					lastActivity: 12,
					group: GROUP,
				},
				runId: BRIDGE_RUN_ID,
				target: `workflow:${BRIDGE_RUN_ID}/reviewer`,
				message: { id: "1", timestamp: 1_725_000_000_001, content: { text: "scope" } },
				...(live === undefined ? {} : { live }),
			} as { handled: boolean; completion?: Promise<unknown> };
			listeners.get("atomic:workflow-pending-stage-message")?.(payload);
			return payload.completion === undefined ? undefined : await payload.completion;
		};
		return { store, dispose, roster, send };
	}

	const FORWARD = { outcome: "forward", target: `workflow:${BRIDGE_RUN_ID}/reviewer-id` };
	const QUEUED = { outcome: "queued", position: 1 };

	test("the roster calls a stage with a session running, and a waiting or session-less stage pending", async () => {
		const cases: [Partial<StageSnapshot>, string][] = [
			[{ status: "running", sessionId: "session-1" }, "running"],
			[{ status: "running", sessionFile: "/sessions/stage.jsonl" }, "running"],
			[{ status: "waiting", sessionId: "session-1", wait: WAIT }, "pending"],
			[{ status: "waiting", sessionFile: "/sessions/stage.jsonl", wait: WAIT }, "pending"],
			[{ status: "running" }, "pending"],
			[{ status: "pending" }, "pending"],
		];
		for (const [patch, lifecycle] of cases) {
			const { dispose, roster } = await bridge(patch);
			assert.deepEqual(
				roster().map((stage) => stage.lifecycle),
				[lifecycle],
				JSON.stringify(patch),
			);
			dispose();
		}
	});

	test("a send to a running stage with a session is forwarded to it, and one to a waiting stage is queued", async () => {
		const running = await bridge({ status: "running", sessionId: "session-1" });
		assert.deepEqual(await running.send(), FORWARD);
		assert.equal(running.store.pendingStageMessagesFor(BRIDGE_RUN_ID, "reviewer-id").length, 0);
		running.dispose();

		// A session known only by its file is a session too.
		const byFile = await bridge({ status: "running", sessionFile: "/sessions/stage.jsonl" });
		assert.deepEqual(await byFile.send(), FORWARD);
		byFile.dispose();

		const waiting = await bridge({ status: "waiting", sessionId: "session-1", wait: WAIT });
		assert.deepEqual(await waiting.send(), QUEUED);
		assert.equal(waiting.store.pendingStageMessagesFor(BRIDGE_RUN_ID, "reviewer-id").length, 1);
		waiting.dispose();
	});

	test("a send that insists on a live delivery is forwarded to a stage that runs, and still queued for one that waits", async () => {
		const running = await bridge({ status: "running" });
		assert.deepEqual(
			await running.send(true),
			FORWARD,
			"a running stage takes a live send even before its session is known",
		);
		running.dispose();

		const waiting = await bridge({ status: "waiting", sessionId: "session-1", wait: WAIT });
		assert.deepEqual(await waiting.send(true), QUEUED, "a waiting stage has no session to take a live send");
		assert.equal(waiting.store.pendingStageMessagesFor(BRIDGE_RUN_ID, "reviewer-id").length, 1);
		waiting.dispose();
	});

	test("a send to a stage that is pending or running without a session is queued for it", async () => {
		for (const status of ["pending", "running"] as const) {
			const pending = await bridge({ status });
			assert.deepEqual(await pending.send(), QUEUED, status);
			pending.dispose();
		}
	});
});

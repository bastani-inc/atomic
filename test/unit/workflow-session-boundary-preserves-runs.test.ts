/** Drive the real session handlers so process-preserving boundaries do not destroy in-flight runs (#2247 / #2462). */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import {
	type ConfiguredDbosDurability,
	DbosDurableBackend,
	type DbosSdkHandle,
} from "../../packages/workflows/src/durable/dbos-backend.js";
import { dbosLifecycleState, resetDbosLifecycleForTests } from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import { initializeDurableBackend, setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { registerWorkflowLifecycleHandlers } from "../../packages/workflows/src/extension/extension-lifecycle.js";
import type { WorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";
import { createWorkflowHilAnswerNotificationState } from "../../packages/workflows/src/extension/hil-answer-notifications.js";
import { createWorkflowLifecycleNotificationState } from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import { inspectRun, statusRuns } from "../../packages/workflows/src/runs/background/status.js";
import {
	adoptStageControlRegistry,
	createStageControlRegistry,
	type StageControlHandle,
	type StageControlStatus,
	stageControlRegistry,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { adoptStore } from "../../packages/workflows/src/shared/store-factory.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

type SessionEventHandler = (event?: unknown, ctx?: unknown) => Promise<unknown>;

const PRESERVE = ["reload", "fork", "new", "resume"] as const;
const CLEAR_ON_START = ["startup", "mystery"] as const;

function bindScope(scope: object): void {
	adoptStore(scope);
	adoptStageControlRegistry(scope);
}

function launchHarness() {
	const events: string[] = [];
	let launched = false;
	const noop = async () => {};
	const sdk: DbosSdkHandle = {
		launch: async () => {
			launched = true;
		},
		shutdown: async () => {
			launched = false;
		},
		startWorkflow: noop,
		retrieveWorkflow: async () => undefined,
		cancelWorkflow: noop,
		resumeWorkflow: noop,
		listAllWorkflows: async () => [],
		listStepRecords: async () => [],
		recordStepOutput: noop,
		deleteWorkflowData: noop,
	};
	const durability: ConfiguredDbosDurability = {
		backend: new DbosDurableBackend(sdk),
		launch: async () => {
			launched = true;
			events.push("launch");
		},
		shutdown: async () => {
			launched = false;
			events.push("shutdown");
		},
	};
	return { events, durability, isLaunched: () => launched };
}

async function readyDurability() {
	const harness = launchHarness();
	setDurableBackend(undefined);
	resetDbosLifecycleForTests(async () => harness.durability);
	await initializeDurableBackend();
	return harness;
}

function captureHandlers(): Map<string, SessionEventHandler> {
	const handlers = new Map<string, SessionEventHandler>();
	registerWorkflowLifecycleHandlers(
		{
			on: (type: string, handler: SessionEventHandler) => {
				handlers.set(type, handler);
			},
		} as unknown as ExtensionAPI,
		{
			runtimeState: {
				persistenceRef: { current: undefined },
				lifecycleNotificationState: createWorkflowLifecycleNotificationState(),
				hilAnswerNotificationState: createWorkflowHilAnswerNotificationState(),
				resetWorkflowDiscoveryForSession() {},
				async ensureWorkflowConfigLoaded() {},
				startWorkflowDiscoveryWarmup() {},
				setNotificationsActive() {},
				updateHostStageSessionDir() {},
			} as unknown as WorkflowExtensionRuntimeState,
			storeWidgetRef: { current: null },
			intercomControlRef: { current: null },
		},
	);
	return handlers;
}

function makeHandle(
	runId: string,
	stageId: string,
	opts: { status?: StageControlStatus; dispose?: () => void } = {},
): StageControlHandle {
	let status: StageControlStatus = opts.status ?? "running";
	return {
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
			status = "paused";
		},
		async resume() {
			status = "running";
			return undefined;
		},
		subscribe() {
			return () => {};
		},
		...(opts.dispose === undefined ? {} : { dispose: opts.dispose }),
	};
}

function startBareRun(id: string, name: string): void {
	store.recordRunStart({ id, name, inputs: {}, status: "running", stages: [], startedAt: 1 } satisfies RunSnapshot);
}

function seedRun(runId: string, stageId: string, promptId: string) {
	startBareRun(runId, "boundary-preserve");
	store.recordStageStart(runId, { id: stageId, name: stageId, status: "running", parentIds: [], toolEvents: [] });
	assert.equal(
		store.recordStagePendingPrompt(runId, stageId, {
			id: promptId,
			kind: "input",
			message: "Continue?",
			createdAt: 2,
		}),
		true,
	);
	const handle = makeHandle(runId, stageId, { status: "awaiting_input" });
	stageControlRegistry.register(handle);
	return { handle, answer: store.awaitStagePendingPrompt(runId, stageId, promptId) };
}

function assertLive(runId: string, stageId: string, promptId: string, handle: StageControlHandle): void {
	const listed = statusRuns();
	assert.equal(listed.length, 1, "run must stay listed");
	assert.equal(listed[0]?.runId, runId);
	assert.equal(listed[0]?.status, "running");
	const inspected = inspectRun(runId);
	assert.equal(inspected.ok, true);
	if (!inspected.ok) return;
	assert.equal(inspected.detail.status, "running");
	assert.equal(inspected.detail.stages[0]?.status, "awaiting_input");
	assert.equal(inspected.detail.stages[0]?.pendingPrompt?.id, promptId);
	assert.equal(stageControlRegistry.get(runId, stageId), handle);
	const liveStageIds = stageControlRegistry
		.run(runId)
		.stages()
		.map((s) => s.stageId);
	assert.deepEqual(liveStageIds, [stageId]);
}

beforeEach(() => {
	bindScope(createEventBus());
	stageControlRegistry.clear();
	store.clear();
});

afterEach(() => {
	stageControlRegistry.clear();
	store.clear();
	setDurableBackend(undefined);
	resetDbosLifecycleForTests();
});

describe("process-preserving session boundaries leave in-flight runs intact", () => {
	for (const reason of PRESERVE) {
		test(`session_start(${reason}) keeps the run listed, reporting, and answerable`, async () => {
			const { handle, answer } = seedRun(`preserve-${reason}`, "ask", "p1");
			let detachedDisposes = 0;
			const detached = makeHandle(`preserve-${reason}`, "done", {
				status: "completed",
				dispose() {
					detachedDisposes += 1;
				},
			});
			stageControlRegistry.register(detached);
			assert.equal(stageControlRegistry.detachControl(`preserve-${reason}`, "done", detached), true);
			const start = captureHandlers().get("session_start");
			assert.ok(start);
			await start({ reason });
			assertLive(`preserve-${reason}`, "ask", "p1", handle);
			assert.equal(stageControlRegistry.get(`preserve-${reason}`, "done"), undefined);
			assert.equal(detachedDisposes, 1);
			assert.equal(store.resolveStagePendingPrompt(`preserve-${reason}`, "ask", "p1", "yes"), true);
			assert.equal(await answer, "yes");
		});

		test(`session_shutdown(${reason}) then session_start(${reason}) keep live executor handles`, async () => {
			const { handle, answer } = seedRun(`roundtrip-${reason}`, "ask", "p1");
			const handlers = captureHandlers();
			const shutdown = handlers.get("session_shutdown");
			const start = handlers.get("session_start");
			assert.ok(shutdown && start);
			await shutdown({ reason });
			await start({ reason });
			assertLive(`roundtrip-${reason}`, "ask", "p1", handle);
			assert.equal(store.resolveStagePendingPrompt(`roundtrip-${reason}`, "ask", "p1", "go"), true);
			assert.equal(await answer, "go");
		});
	}

	test("a distinct successor EventBus does not list the preserved run; the predecessor scope stays answerable", async () => {
		for (const reason of ["new", "resume", "fork"] as const) {
			const predecessor = createEventBus();
			const successor = createEventBus();
			bindScope(predecessor);
			store.clear();
			stageControlRegistry.clear();
			const runId = `adopt-${reason}`;
			const { handle, answer } = seedRun(runId, "ask", "p1");
			const handlers = captureHandlers();
			const shutdown = handlers.get("session_shutdown");
			const start = handlers.get("session_start");
			assert.ok(shutdown && start);
			await shutdown({ reason });
			bindScope(successor);
			await start({ reason });
			assert.deepEqual(
				statusRuns().map((entry) => entry.runId),
				[],
				`${reason} successor session view`,
			);
			assert.equal(inspectRun(runId).ok, false);
			bindScope(predecessor);
			assertLive(runId, "ask", "p1", handle);
			assert.equal(store.resolveStagePendingPrompt(runId, "ask", "p1", "yes"), true);
			assert.equal(await answer, "yes");
		}
	});

	for (const reason of CLEAR_ON_START) {
		test(`session_start(${reason}) still kills the in-flight run and clears handles`, async () => {
			const { answer } = seedRun(`clear-${reason}`, "ask", "p1");
			const start = captureHandlers().get("session_start");
			assert.ok(start);
			await start({ reason });
			assert.deepEqual(statusRuns(), []);
			assert.equal(inspectRun(`clear-${reason}`).ok, false);
			assert.equal(stageControlRegistry.get(`clear-${reason}`, "ask"), undefined);
			await assert.rejects(answer);
		});
	}
});

describe("clearDetached disposes only detached handles", () => {
	test("drops detached handles, retains controlling ones, and prunes emptied run maps", () => {
		const registry = createStageControlRegistry();
		let detachedDisposes = 0;
		let liveDisposes = 0;
		const live = makeHandle("keep-run", "live", {
			dispose() {
				liveDisposes += 1;
			},
		});
		const detachedSameRun = makeHandle("keep-run", "done", {
			status: "completed",
			dispose() {
				detachedDisposes += 1;
			},
		});
		const onlyDetached = makeHandle("empty-run", "orphan", {
			status: "completed",
			dispose() {
				detachedDisposes += 1;
			},
		});
		registry.register(live);
		registry.register(detachedSameRun);
		registry.register(onlyDetached);
		assert.equal(registry.detachControl("keep-run", "done", detachedSameRun), true);
		assert.equal(registry.detachControl("empty-run", "orphan", onlyDetached), true);
		assert.equal(registry.has("empty-run"), true);
		assert.equal(registry.has("keep-run"), true);
		registry.clearDetached();
		assert.equal(registry.get("keep-run", "live"), live);
		const keptStageIds = registry
			.run("keep-run")
			.stages()
			.map((stage) => stage.stageId);
		assert.deepEqual(keptStageIds, ["live"]);
		assert.equal(registry.get("keep-run", "done"), undefined);
		assert.equal(registry.get("empty-run", "orphan"), undefined);
		assert.deepEqual(registry.forRun("empty-run"), []);
		assert.equal(registry.has("empty-run"), false);
		assert.equal(registry.has("keep-run"), true);
		assert.equal(liveDisposes, 0);
		assert.equal(detachedDisposes, 2);
	});
});

describe("quit still pauses, clears, and shuts DBOS down once", () => {
	test("session_shutdown(quit) pauses the run, clears every handle, and shuts DBOS down exactly once", async () => {
		const { events, isLaunched } = await readyDurability();
		startBareRun("quit-run", "quit-boundary");
		store.recordStageStart("quit-run", {
			id: "live",
			name: "live",
			status: "running",
			parentIds: [],
			toolEvents: [],
		});
		let disposed = 0;
		stageControlRegistry.register(
			makeHandle("quit-run", "live", {
				dispose() {
					disposed += 1;
				},
			}),
		);
		const shutdown = captureHandlers().get("session_shutdown");
		assert.ok(shutdown);
		await shutdown({ reason: "quit" });
		await shutdown({ reason: "quit" });
		const run = store.runs().find((candidate) => candidate.id === "quit-run");
		assert.equal(run?.status, "paused");
		assert.equal(run?.exitReason, "quit");
		assert.equal(run?.endedAt, undefined);
		assert.equal(stageControlRegistry.get("quit-run", "live"), undefined);
		assert.equal(disposed, 1);
		assert.equal(events.filter((event) => event === "shutdown").length, 1);
		assert.equal(isLaunched(), false);
		assert.equal(dbosLifecycleState(), "shut_down");
	});

	for (const reason of PRESERVE) {
		test(`session_shutdown(${reason}) flushes DBOS rather than shutting it down`, async () => {
			const { events, isLaunched } = await readyDurability();
			const shutdown = captureHandlers().get("session_shutdown");
			assert.ok(shutdown);
			await shutdown({ reason });
			assert.equal(events.includes("shutdown"), false);
			assert.equal(isLaunched(), true);
			assert.equal(dbosLifecycleState(), "ready");
		});
	}
});

describe("/new and /resume confirmation no longer claims workflows are stopped", () => {
	test("session_before_switch tells the user in-flight workflows keep running", async () => {
		for (const reason of ["new", "resume"] as const) {
			store.clear();
			startBareRun(`switch-${reason}`, "switch-confirm");
			const beforeSwitch = captureHandlers().get("session_before_switch");
			assert.ok(beforeSwitch);
			const prompts: Array<{ title: string; message?: string }> = [];
			assert.equal(
				await beforeSwitch(
					{ reason },
					{
						ui: {
							confirm: async (title: string, message?: string) => {
								prompts.push({ title, message });
								return true;
							},
						},
					},
				),
				undefined,
			);
			const promptText = `${prompts[0]?.title}\n${prompts[0]?.message}`;
			assert.match(promptText, /keeps? .* running/i);
			assert.match(promptText, /session that started them/i);
			assert.doesNotMatch(promptText, /\/workflow status/i);
			assert.doesNotMatch(promptText, /stop|kill|clear workflow history/i);
			assert.equal(store.runs()[0]?.endedAt, undefined);
		}
	});

	test("declining still cancels the switch and rewords the notice", async () => {
		for (const reason of ["new", "resume"] as const) {
			store.clear();
			startBareRun(`decline-${reason}`, "switch-decline");
			const beforeSwitch = captureHandlers().get("session_before_switch");
			assert.ok(beforeSwitch);
			const notifications: Array<{ message: string }> = [];
			assert.deepEqual(
				await beforeSwitch(
					{ reason },
					{
						ui: {
							confirm: async () => false,
							notify: (message: string) => notifications.push({ message }),
						},
					},
				),
				{ cancel: true },
			);
			assert.equal(store.runs()[0]?.endedAt, undefined);
			assert.match(
				notifications.at(-1)?.message ?? "",
				reason === "new" ? /New session cancelled/i : /Resume cancelled/i,
			);
			assert.doesNotMatch(notifications.at(-1)?.message ?? "", /left unchanged/i);
		}
	});
});

/** Drive the real session handlers: /reload preserves in-flight runs (#2247 / #2462); switching sessions quits them at a resumable checkpoint (#3203). */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import {
	type ConfiguredDbosDurability,
	DbosDurableBackend,
	type DbosSdkHandle,
} from "../../packages/workflows/src/durable/dbos-backend.js";
import { dbosLifecycleState, resetDbosLifecycleForTests } from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import { initializeDurableBackend, setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { adoptWorkflowSessionRunState } from "../../packages/workflows/src/extension/adopt-session-run-state.js";
import {
	registerWorkflowLifecycleHandlers,
	sessionSwitchQuitConfirmation,
} from "../../packages/workflows/src/extension/extension-lifecycle.js";
import type { WorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";
import { createWorkflowHilAnswerNotificationState } from "../../packages/workflows/src/extension/hil-answer-notifications.js";
import { createWorkflowLifecycleNotificationState } from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { currentJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { inspectRun, statusRuns } from "../../packages/workflows/src/runs/background/status.js";
import {
	adoptStageControlRegistry,
	createStageControlRegistry,
	type StageControlHandle,
	type StageControlStatus,
	stageControlRegistry,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { adoptStore, currentWorkflowStore } from "../../packages/workflows/src/shared/store-factory.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

type SessionEventHandler = (event?: unknown, ctx?: unknown) => Promise<unknown>;

const PRESERVE = ["reload", "fork", "new", "resume"] as const;
const CLEAR_ON_START = ["startup", "mystery"] as const;

// #3105: a known empty host must never reclaim another host's live store on reload.
test("owner-scoped reload does not reclaim the latest sibling's workflow state", () => {
	const scope = {};
	adoptWorkflowSessionRunState(scope, true);
	const original = currentWorkflowStore();
	adoptWorkflowSessionRunState({}, true);
	const sibling = currentWorkflowStore();
	startBareRun("sibling-live", "sibling");
	adoptWorkflowSessionRunState(scope, true);
	assert.equal(currentWorkflowStore(), original);
	assert.equal(original.runs().length, 0);
	assert.equal(sibling.runs().length, 1);
});

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

function captureHandlers(lifecycleScope: object = {}): Map<string, SessionEventHandler> {
	const handlers = new Map<string, SessionEventHandler>();
	registerWorkflowLifecycleHandlers(
		{
			lifecycleScope,
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
	opts: { status?: StageControlStatus; dispose?: () => void | Promise<void> } = {},
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

// #3105: actual execution remains with its retained owner after another host adopts state.
test("a live workflow survives replacement and sibling quit, then settles on owner quit", async () => {
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const owner = {};
	adoptWorkflowSessionRunState({});
	const first = captureHandlers(owner);
	const ownedStore = currentWorkflowStore();
	const jobs = currentJobTracker();
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let aborted = false;
	const runtime = createExtensionRuntime({
		definitions: [
			workflow({
				name: "retained-owner",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.tool("wait", {}, async ({ signal }) => {
						entered();
						await new Promise<void>((resolve) =>
							signal.addEventListener("abort", () => resolve(), { once: true }),
						);
						aborted = true;
						return "stopped";
					});
					return {};
				},
			}),
		],
	});
	adoptWorkflowSessionRunState({});
	const sibling = captureHandlers();
	const siblingStore = currentWorkflowStore();
	const accepted = await runtime.dispatch({ workflow: "retained-owner", action: "run", inputs: {} });
	await started;
	assert.ok("status" in accepted);
	assert.equal(accepted.status, "running");
	assert.equal(ownedStore.runs().length, 1);
	assert.equal(siblingStore.runs().length, 0);
	await first.get("session_shutdown")!({ reason: "reload" });
	await sibling.get("session_shutdown")!({ reason: "quit" });
	assert.equal(aborted, false);
	adoptWorkflowSessionRunState({});
	const successor = captureHandlers(owner);
	await successor.get("session_shutdown")!({ reason: "quit" });
	assert.equal(aborted, true);
	assert.equal(ownedStore.runs()[0]?.status, "paused");
	assert.equal(backend.getWorkflow(ownedStore.runs()[0]!.id)?.status, "paused");
	assert.deepEqual(jobs.runIds(), []);
});

// #3105: cleanup captures the adopted generation, never the newest singleton facade.
test("owner quit drains retained generations, preserves sibling and borrowed backend", async () => {
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const owner = {};
	bindScope({});
	const first = captureHandlers(owner);
	let firstDisposed = false;
	stageControlRegistry.register(
		makeHandle("old", "stage", {
			dispose: async () => {
				firstDisposed = true;
			},
		}),
	);
	await first.get("session_shutdown")!({ reason: "reload" });
	assert.equal(firstDisposed, false);
	bindScope({});
	const successor = captureHandlers(owner);
	let successorDisposed = false;
	stageControlRegistry.register(
		makeHandle("new", "stage", {
			dispose: async () => {
				successorDisposed = true;
			},
		}),
	);
	bindScope({});
	const sibling = captureHandlers();
	let siblingDisposed = false;
	stageControlRegistry.register(
		makeHandle("sibling", "stage", {
			dispose: async () => {
				siblingDisposed = true;
			},
		}),
	);
	await successor.get("session_shutdown")!({ reason: "quit" });
	assert.equal(firstDisposed, true);
	assert.equal(successorDisposed, true);
	assert.equal(siblingDisposed, false);
	assert.equal(await initializeDurableBackend(), backend);
	await sibling.get("session_shutdown")!({ reason: "quit" });
	assert.equal(siblingDisposed, true);
	assert.equal(await initializeDurableBackend(), backend);
});

test("owner quit attempts all generation cleanup after a disposal failure", async () => {
	setDurableBackend(new InMemoryDurableBackend());
	const owner = {};
	bindScope({});
	const first = captureHandlers(owner);
	stageControlRegistry.register(
		makeHandle("old", "stage", {
			dispose: async () => {
				throw new Error("old stage failed");
			},
		}),
	);
	await first.get("session_shutdown")!({ reason: "reload" });
	bindScope({});
	const successor = captureHandlers(owner);
	let disposed = false;
	stageControlRegistry.register(
		makeHandle("new", "stage", {
			dispose: async () => {
				disposed = true;
			},
		}),
	);
	await assert.rejects(successor.get("session_shutdown")!({ reason: "quit" }), /old stage failed/);
	assert.equal(disposed, true);
});

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
	}

	test("session_shutdown(reload) then session_start(reload) keep live executor handles", async () => {
		const { handle, answer } = seedRun("roundtrip-reload", "ask", "p1");
		const handlers = captureHandlers();
		const shutdown = handlers.get("session_shutdown");
		const start = handlers.get("session_start");
		assert.ok(shutdown && start);
		await shutdown({ reason: "reload" });
		await start({ reason: "reload" });
		assertLive("roundtrip-reload", "ask", "p1", handle);
		assert.equal(store.resolveStagePendingPrompt("roundtrip-reload", "ask", "p1", "go"), true);
		assert.equal(await answer, "go");
	});
});

function waitingWorkflowRuntime(name: string) {
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let aborted = false;
	const runtime = createExtensionRuntime({
		definitions: [
			workflow({
				name,
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.tool("wait", {}, async ({ signal }) => {
						entered();
						await new Promise<void>((resolve) =>
							signal.addEventListener("abort", () => resolve(), { once: true }),
						);
						aborted = true;
						return "stopped";
					});
					return {};
				},
			}),
		],
	});
	return {
		async launch() {
			const accepted = await runtime.dispatch({ workflow: name, action: "run", inputs: {} });
			await started;
			assert.ok("status" in accepted);
			assert.equal(accepted.status, "running");
		},
		aborted: () => aborted,
	};
}

describe("switching sessions quits in-flight runs at a resumable checkpoint (#3203)", () => {
	for (const reason of ["new", "resume", "fork"] as const) {
		test(`session_shutdown(${reason}) pauses the run durably and keeps the lifetime open (#3203)`, async () => {
			const backend = new InMemoryDurableBackend();
			setDurableBackend(backend);
			const owner = {};
			adoptWorkflowSessionRunState({});
			const first = captureHandlers(owner);
			const firstStore = currentWorkflowStore();
			const jobs = currentJobTracker();
			const firstRun = waitingWorkflowRuntime(`switch-first-${reason}`);
			await firstRun.launch();
			await first.get("session_shutdown")!({ reason });
			assert.equal(firstRun.aborted(), true);
			const firstSnapshot = firstStore.runs()[0];
			assert.equal(firstSnapshot?.status, "paused");
			assert.equal(backend.getWorkflow(firstSnapshot!.id)?.status, "paused");
			assert.deepEqual(jobs.runIds(), []);

			adoptWorkflowSessionRunState({});
			const successor = captureHandlers(owner);
			await successor.get("session_start")!({ reason });
			const successorStore = currentWorkflowStore();
			const secondRun = waitingWorkflowRuntime(`switch-second-${reason}`);
			await secondRun.launch();
			await successor.get("session_shutdown")!({ reason });
			assert.equal(secondRun.aborted(), true);
			assert.equal(successorStore.runs()[0]?.status, "paused");
		});
	}

	test("session_shutdown(reload) keeps the run executing (#3203)", async () => {
		setDurableBackend(new InMemoryDurableBackend());
		adoptWorkflowSessionRunState({});
		const handlers = captureHandlers();
		const ownedStore = currentWorkflowStore();
		const run = waitingWorkflowRuntime("switch-reload");
		await run.launch();
		await handlers.get("session_shutdown")!({ reason: "reload" });
		assert.equal(run.aborted(), false);
		assert.equal(ownedStore.runs()[0]?.status, "running");
		await handlers.get("session_shutdown")!({ reason: "quit" });
		assert.equal(run.aborted(), true);
	});
});

describe("startup and unrecognised session starts still clear", () => {
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
		// #3105: a started session owns durability; discovery alone must not.
		const handlers = captureHandlers();
		await handlers.get("session_start")!({ reason: "startup" });
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
		const shutdown = handlers.get("session_shutdown");
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

describe("session-switch confirmation says running workflows will be quit (#3203)", () => {
	const SWITCH_EVENTS = [
		{ reason: "new", event: "session_before_switch", cancelled: /New session cancelled/ },
		{ reason: "resume", event: "session_before_switch", cancelled: /Resume cancelled/ },
		{ reason: "fork", event: "session_before_fork", cancelled: /Fork cancelled/ },
	] as const;

	for (const { reason, event, cancelled } of SWITCH_EVENTS) {
		test(`${reason} asks to quit running workflows and says they can be resumed (#3203)`, async () => {
			startBareRun(`switch-${reason}-a`, "switch-confirm");
			startBareRun(`switch-${reason}-b`, "switch-confirm");
			const handler = captureHandlers().get(event);
			assert.ok(handler);
			const prompts: Array<{ title: string; message?: string }> = [];
			const result = await handler(
				{ reason, entryId: "e1", position: "before" },
				{
					ui: {
						confirm: async (title: string, message?: string) => {
							prompts.push({ title, message });
							return true;
						},
					},
				},
			);
			assert.equal(result, undefined);
			assert.equal(prompts.length, 1);
			assert.match(prompts[0]!.title, /^Quit 2 running workflows and /);
			assert.match(prompts[0]!.message ?? "", /quits 2 running workflows now/);
			assert.match(prompts[0]!.message ?? "", /last checkpoint/);
			assert.match(prompts[0]!.message ?? "", /resumed later with \/workflow resume/);
			assert.doesNotMatch(`${prompts[0]!.title}\n${prompts[0]!.message}`, /keeps? .* running/i);
		});

		test(`declining ${reason} cancels it and leaves workflows running (#3203)`, async () => {
			startBareRun(`decline-${reason}`, "switch-decline");
			const handler = captureHandlers().get(event);
			assert.ok(handler);
			const notifications: string[] = [];
			const result = await handler(
				{ reason, entryId: "e1", position: "before" },
				{
					ui: {
						confirm: async () => false,
						notify: (message: string) => notifications.push(message),
					},
				},
			);
			assert.deepEqual(result, { cancel: true });
			assert.equal(store.runs()[0]?.status, "running");
			assert.match(notifications.at(-1) ?? "", cancelled);
			assert.match(notifications.at(-1) ?? "", /cancelled; running workflows keep running\./);
		});

		test(`${reason} without an interactive UI proceeds so shutdown can quit the runs (#3203)`, async () => {
			startBareRun(`headless-${reason}`, "switch-headless");
			const handler = captureHandlers().get(event);
			assert.ok(handler);
			assert.equal(await handler({ reason, entryId: "e1", position: "before" }, {}), undefined);
		});
	}

	test("no confirmation is shown when nothing is running (#3203)", async () => {
		const handler = captureHandlers().get("session_before_fork");
		assert.ok(handler);
		let asked = false;
		const result = await handler(
			{ entryId: "e1", position: "before" },
			{
				ui: {
					confirm: async () => {
						asked = true;
						return true;
					},
				},
			},
		);
		assert.equal(result, undefined);
		assert.equal(asked, false);
	});

	test("confirmation copy uses singular wording for one run (#3203)", () => {
		assert.deepEqual(sessionSwitchQuitConfirmation("new", 1), {
			title: "Quit 1 running workflow and start a new session?",
			message:
				"Continuing quits 1 running workflow now. It stops at its last checkpoint and can be resumed later with /workflow resume.",
		});
	});
});

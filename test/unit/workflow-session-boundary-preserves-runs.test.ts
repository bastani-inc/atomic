/** Drive the real session handlers: /reload preserves in-flight runs (#2247 / #2462); switching sessions quits them at a resumable checkpoint (#3203). */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { reclaimReleasedRunsOwnedBy } from "../../packages/workflows/src/durable/sdk-owner-release.js";
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
import { JournalTestBackend } from "../helpers/journal-backend.js";
import {
	currentStoreBackend as getDurableBackend,
	configureCurrentTestStoreBackend as setDurableBackend,
} from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

type SessionEventHandler = (event?: unknown, ctx?: unknown) => Promise<unknown>;

const PRESERVE = ["reload", "fork", "new", "resume"] as const;
const CLEAR_ON_START = ["startup", "mystery"] as const;

// #3105: a known empty host must never reclaim another host's live store on reload.
test("owner-scoped reload does not reclaim the latest sibling's workflow state", async () => {
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

async function readyDurability() {
	const backend = await JournalTestBackend.create();
	setDurableBackend(backend);
	return backend;
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
				configLoadRef: { current: null },
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
	const backend = await createMemoryTestBackend();
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
	const backend = await createMemoryTestBackend();
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
	assert.equal(getDurableBackend(), backend);
	await sibling.get("session_shutdown")!({ reason: "quit" });
	assert.equal(siblingDisposed, true);
	assert.equal(getDurableBackend(), backend);
});

test("owner quit attempts all generation cleanup after a disposal failure", async () => {
	setDurableBackend(await createMemoryTestBackend());
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
	store.recordRunStart({
		id,
		name,
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	} satisfies RunSnapshot);
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
			const backend = await createMemoryTestBackend();
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
		setDurableBackend(await createMemoryTestBackend());
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

function ownedCheckpointedWaitingRun(name: string, modelOwner: string) {
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const runtime = createExtensionRuntime({
		definitions: [
			workflow({
				name,
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.tool("checkpointed", {}, async () => "done");
					await ctx.tool("wait", {}, async ({ signal }) => {
						entered();
						await new Promise<void>((resolve) =>
							signal.addEventListener("abort", () => resolve(), { once: true }),
						);
						return "stopped";
					});
					return {};
				},
			}),
		],
	});
	return {
		async launch(): Promise<string> {
			const accepted = await runtime.dispatch(
				{ workflow: name, action: "run", inputs: {} },
				{ origin: "agent", modelOwner },
			);
			await started;
			assert.ok("status" in accepted);
			assert.equal(accepted.status, "running");
			return accepted.runId;
		},
	};
}

async function startSession(sessionId: string): Promise<Map<string, SessionEventHandler>> {
	const handlers = captureHandlers();
	await handlers.get("session_start")!({ reason: "startup" }, { sessionManager: { getSessionId: () => sessionId } });
	return handlers;
}

describe("a disposed session releases its paused agent-launched runs for adoption (#3566)", () => {
	test("session_shutdown(quit) records a durable release only for the runs its own session owns (#3566)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		adoptWorkflowSessionRunState({});
		const handlers = await startSession("session-a");
		const own = await ownedCheckpointedWaitingRun("release-own", "session-a").launch();
		const foreign = await ownedCheckpointedWaitingRun("release-foreign", "session-b").launch();
		await handlers.get("session_shutdown")!({ reason: "quit" });
		assert.equal(backend.getWorkflow(own)?.status, "paused");
		assert.equal(backend.getWorkflow(own)?.modelOwner, "session-a");
		assert.equal(backend.getWorkflow(own)?.releasedModelOwner, "session-a");
		assert.equal(backend.getWorkflow(foreign)?.status, "paused");
		assert.equal(backend.getWorkflow(foreign)?.releasedModelOwner, undefined);
	});

	test("session_shutdown(quit) releases a run that was awaiting human input (#3566)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await backend.commitWorkflowRegistration({
			workflowId: "release-awaiting-input",
			name: "release-awaiting-input",
			inputs: {},
			status: "running",
			createdAt: 1,
			modelOwner: "session-a",
			origin: "agent",
			pendingPrompts: 1,
		});
		const handlers = await startSession("session-a");
		const { answer } = seedRun("release-awaiting-input", "ask", "p1");
		answer.catch(() => undefined);
		await handlers.get("session_shutdown")!({ reason: "quit" });
		assert.equal(backend.getWorkflow("release-awaiting-input")?.status, "paused");
		assert.equal(backend.getWorkflow("release-awaiting-input")?.pendingPrompts, 1);
		assert.equal(backend.getWorkflow("release-awaiting-input")?.releasedModelOwner, "session-a");
	});

	test("session_shutdown(reload) keeps its runs executing, owned, and unreleased (#3566)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		adoptWorkflowSessionRunState({});
		const handlers = await startSession("session-a");
		const own = await ownedCheckpointedWaitingRun("release-kept-reload", "session-a").launch();
		await handlers.get("session_shutdown")!({ reason: "reload" });
		assert.equal(backend.getWorkflow(own)?.status, "running");
		assert.equal(backend.getWorkflow(own)?.releasedModelOwner, undefined);
		await handlers.get("session_shutdown")!({ reason: "quit" });
	});
});

interface SwitchContext {
	readonly hasUI?: boolean;
	readonly ui?: {
		readonly notify: (message: string) => void;
		readonly setWidget: () => void;
		readonly requestRender: () => void;
	};
}

function registerPausedOwnedRun(
	backend: DurableWorkflowBackend,
	runId: string,
	modelOwner: string,
	overrides: Partial<Parameters<DurableWorkflowBackend["commitWorkflowRegistration"]>[0]> = {},
): Promise<void> {
	return backend.commitWorkflowRegistration({
		workflowId: runId,
		name: "reviewer",
		inputs: {},
		status: "paused",
		createdAt: 1,
		updatedAt: 1,
		completedCheckpoints: 1,
		modelOwner,
		origin: "agent",
		invocationCwd: process.cwd(),
		...overrides,
	});
}

async function startSwitchedSession(
	lifecycleScope: object,
	sessionId: string,
	reason: string,
	context: SwitchContext = {},
): Promise<Map<string, SessionEventHandler>> {
	const handlers = captureHandlers(lifecycleScope);
	await handlers.get("session_start")!(
		{ reason },
		{ sessionManager: { getSessionId: () => sessionId }, cwd: process.cwd(), ...context },
	);
	return handlers;
}

function notifyingUi(notices: string[]): SwitchContext {
	return { ui: { notify: (message: string) => notices.push(message), setWidget() {}, requestRender() {} } };
}

const RELEASE_RUN_A = "11111111-1111-4111-8111-111111111111";
const RELEASE_RUN_B = "22222222-2222-4222-8222-222222222222";
const RELEASE_RUN_C = "33333333-3333-4333-8333-333333333333";

describe("the successor may start before the departing session's shutdown handlers run (#3569)", () => {
	for (const reason of ["new", "resume", "fork"] as const) {
		test(`session_start(${reason}) completes the quit-and-release handoff itself and announces the run (#3569)`, async () => {
			const backend = await createMemoryTestBackend();
			setDurableBackend(backend);
			adoptWorkflowSessionRunState({});
			const scope = {};
			const departing = await startSwitchedSession(scope, "session-a", "startup");
			const own = await ownedCheckpointedWaitingRun(`late-shutdown-own-${reason}`, "session-a").launch();
			assert.equal(backend.getWorkflow(own)?.status, "running");

			const notices: string[] = [];
			await startSwitchedSession(scope, "session-b", reason, notifyingUi(notices));

			assert.equal(backend.getWorkflow(own)?.status, "paused");
			assert.equal(backend.getWorkflow(own)?.releasedModelOwner, "session-a");
			assert.equal(notices.length, 1, notices.join("\n---\n"));
			assert.match(notices[0]!, new RegExp(`/workflow resume ${own}\\b`));

			const releases = vi.spyOn(backend, "commitWorkflowStatusTransition");
			await departing.get("session_shutdown")!({ reason });
			assert.equal(
				releases.mock.calls.length,
				0,
				"the late shutdown handler must not release or quit a second time",
			);
			assert.equal(backend.getWorkflow(own)?.releasedModelOwner, "session-a");
		});
	}

	test("a departing shutdown that already ran is not repeated by the successor's session_start (#3569)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerPausedOwnedRun(backend, RELEASE_RUN_A, "session-a", { name: "alpha" });
		const scope = {};
		const departing = await startSwitchedSession(scope, "session-a", "startup");
		await departing.get("session_shutdown")!({ reason: "new" });
		const releases = vi.spyOn(backend, "commitWorkflowStatusTransition");
		const notices: string[] = [];
		await startSwitchedSession(scope, "session-b", "new", notifyingUi(notices));
		assert.equal(releases.mock.calls.length, 0);
		assert.equal(notices.length, 1);
	});

	test("disposing the departing session waits for a successor's running handoff instead of overlapping it (#3569)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerPausedOwnedRun(backend, RELEASE_RUN_A, "session-a");
		const scope = {};
		const departing = await startSwitchedSession(scope, "session-a", "startup");
		const gate = Promise.withResolvers<void>();
		const original = backend.commitWorkflowStatusTransition.bind(backend);
		const calls: string[] = [];
		vi.spyOn(backend, "commitWorkflowStatusTransition").mockImplementation(async (...args) => {
			calls.push(calls.length === 0 ? "handoff-release" : "later-release");
			if (calls.length === 1) await gate.promise;
			return original(...args);
		});

		const successor = startSwitchedSession(scope, "session-b", "new");
		await vi.waitFor(() => assert.deepEqual(calls, ["handoff-release"]));
		const disposing = departing.get("session_shutdown")!({ reason: "quit" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(calls, ["handoff-release"], "dispose must not overlap the handoff");

		gate.resolve();
		await Promise.all([successor, disposing]);
		assert.equal(backend.getWorkflow(RELEASE_RUN_A)?.releasedModelOwner, "session-a");
	});

	test("a second switch before anyone adopts keeps the first release and still announces the run (#3569)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		adoptWorkflowSessionRunState({});
		const scope = {};
		const first = await startSwitchedSession(scope, "session-a", "startup");
		const own = await ownedCheckpointedWaitingRun("chained-switch-own", "session-a").launch();
		await first.get("session_shutdown")!({ reason: "new" });
		assert.equal(backend.getWorkflow(own)?.releasedModelOwner, "session-a");

		const second = await startSwitchedSession(scope, "session-b", "new", notifyingUi([]));
		await second.get("session_shutdown")!({ reason: "new" });
		assert.equal(backend.getWorkflow(own)?.status, "paused");
		assert.equal(backend.getWorkflow(own)?.modelOwner, "session-a");
		assert.equal(
			backend.getWorkflow(own)?.releasedModelOwner,
			"session-a",
			"the second switch must not revoke the release",
		);

		const notices: string[] = [];
		await startSwitchedSession(scope, "session-c", "new", notifyingUi(notices));
		assert.equal(notices.length, 1, notices.join("\n---\n"));
		assert.match(notices[0]!, new RegExp(`/workflow resume ${own}\\b`));
	});

	test("returning to the owner session reclaims its released run instead of announcing it or leaving it adoptable (#3569)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		adoptWorkflowSessionRunState({});
		const scope = {};
		const owner = await startSwitchedSession(scope, "session-a", "startup");
		const own = await ownedCheckpointedWaitingRun("reclaim-own", "session-a").launch();
		await owner.get("session_shutdown")!({ reason: "new" });
		const away = await startSwitchedSession(scope, "session-b", "new", notifyingUi([]));
		await away.get("session_shutdown")!({ reason: "resume" });
		assert.equal(backend.getWorkflow(own)?.releasedModelOwner, "session-a");

		const notices: string[] = [];
		await startSwitchedSession(scope, "session-a", "resume", notifyingUi(notices));

		assert.deepEqual(notices, [], "the owner is not told about its own run");
		assert.equal(backend.getWorkflow(own)?.status, "paused");
		assert.equal(backend.getWorkflow(own)?.modelOwner, "session-a");
		assert.equal(
			backend.getWorkflow(own)?.releasedModelOwner,
			undefined,
			"no other session may adopt a live owner's run",
		);
	});

	test("a successor never reclaims a run another session released (#3569)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerPausedOwnedRun(backend, RELEASE_RUN_A, "session-a", { releasedModelOwner: "session-a" });
		const notices: string[] = [];
		await startSwitchedSession({}, "session-b", "new", notifyingUi(notices));
		assert.equal(backend.getWorkflow(RELEASE_RUN_A)?.releasedModelOwner, "session-a");
	});

	test("reclaim never clears a newer release written by another process (#3569)", async () => {
		const backend = await createMemoryTestBackend();
		await registerPausedOwnedRun(backend, RELEASE_RUN_A, "session-b", {
			releasedModelOwner: "session-b",
			updatedAt: 5,
		});
		const current = backend.getWorkflow(RELEASE_RUN_A)!;
		const staleLocalCopy = { ...current, modelOwner: "session-a", releasedModelOwner: "session-a", updatedAt: 1 };
		const staleView = Object.create(backend, {
			getWorkflow: { value: () => staleLocalCopy },
			listResumableWorkflows: { value: () => [staleLocalCopy] },
		}) as DurableWorkflowBackend;

		await reclaimReleasedRunsOwnedBy(staleView, "session-a");

		assert.equal(backend.getWorkflow(RELEASE_RUN_A)?.modelOwner, "session-b");
		assert.equal(
			backend.getWorkflow(RELEASE_RUN_A)?.releasedModelOwner,
			"session-b",
			"the newer owner's release must survive a stale reclaim",
		);
	});

	test("session_start(startup) and session_start(reload) never run the departing handoff (#3569)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		adoptWorkflowSessionRunState({});
		const scope = {};
		await startSwitchedSession(scope, "session-a", "startup");
		const own = await ownedCheckpointedWaitingRun("late-shutdown-reload", "session-a").launch();
		await startSwitchedSession(scope, "session-a", "reload");
		assert.equal(backend.getWorkflow(own)?.status, "running");
		assert.equal(backend.getWorkflow(own)?.releasedModelOwner, undefined);
	});
});

describe("switching sessions releases the previous session's paused runs for the successor (#3569)", () => {
	for (const reason of ["new", "resume", "fork"] as const) {
		test(`session_shutdown(${reason}) quits, then durably releases only the previous session's own runs (#3569)`, async () => {
			const backend = await createMemoryTestBackend();
			setDurableBackend(backend);
			adoptWorkflowSessionRunState({});
			const handlers = await startSession("session-a");
			const own = await ownedCheckpointedWaitingRun(`switch-release-own-${reason}`, "session-a").launch();
			const foreign = await ownedCheckpointedWaitingRun(`switch-release-foreign-${reason}`, "session-b").launch();
			assert.equal(backend.getWorkflow(own)?.status, "running");
			await handlers.get("session_shutdown")!({ reason }, { sessionManager: { getSessionId: () => "session-b" } });
			assert.equal(backend.getWorkflow(own)?.status, "paused");
			assert.equal(backend.getWorkflow(own)?.modelOwner, "session-a");
			assert.equal(backend.getWorkflow(own)?.releasedModelOwner, "session-a");
			assert.equal(backend.getWorkflow(foreign)?.status, "paused");
			assert.equal(backend.getWorkflow(foreign)?.releasedModelOwner, undefined);
			await handlers.get("session_shutdown")!({ reason: "quit" });
		});

		test(`session_shutdown(${reason}) releases in a headless host without any UI (#3569)`, async () => {
			const backend = await createMemoryTestBackend();
			setDurableBackend(backend);
			await registerPausedOwnedRun(backend, RELEASE_RUN_A, "session-a");
			const handlers = await startSwitchedSession({}, "session-a", "startup", { hasUI: false });
			const before = reason === "fork" ? handlers.get("session_before_fork") : handlers.get("session_before_switch");
			assert.equal(await before!({ reason }, { hasUI: false }), undefined);
			await handlers.get("session_shutdown")!({ reason });
			assert.equal(backend.getWorkflow(RELEASE_RUN_A)?.releasedModelOwner, "session-a");
		});

		test(`session_shutdown(${reason}) durably releases the checkpointed run (#3569)`, async () => {
			const backend = await readyDurability();
			await registerPausedOwnedRun(backend, RELEASE_RUN_A, "session-a");
			const order: string[] = [];
			vi.spyOn(backend, "commitWorkflowStatusTransition").mockImplementation(async (...args) => {
				order.push(args[7] === undefined ? "transition" : "release");
				return true;
			});
			const handlers = await startSwitchedSession({}, "session-a", "startup");
			await handlers.get("session_shutdown")!({ reason });
			assert.deepEqual(order, ["release"]);
			assert.equal(getDurableBackend(), backend);
		});
	}

	test("session_shutdown(reload) does not release, so the run keeps executing and owned (#3569)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		adoptWorkflowSessionRunState({});
		const handlers = await startSession("session-a");
		const own = await ownedCheckpointedWaitingRun("switch-reload-no-release", "session-a").launch();
		await registerPausedOwnedRun(backend, RELEASE_RUN_B, "session-a");
		await handlers.get("session_shutdown")!({ reason: "reload" });
		assert.equal(backend.getWorkflow(own)?.status, "running");
		assert.equal(backend.getWorkflow(own)?.releasedModelOwner, undefined);
		assert.equal(backend.getWorkflow(RELEASE_RUN_B)?.releasedModelOwner, undefined);
		await handlers.get("session_shutdown")!({ reason: "quit" });
	});

	for (const reason of ["new", "resume", "fork"] as const) {
		test(`the successor's session_start(${reason}) lists the released in-scope runs with full resume commands (#3569)`, async () => {
			const backend = await createMemoryTestBackend();
			setDurableBackend(backend);
			await registerPausedOwnedRun(backend, RELEASE_RUN_A, "session-a", { name: "alpha" });
			await registerPausedOwnedRun(backend, RELEASE_RUN_B, "session-a", {
				name: "elsewhere",
				invocationCwd: "/another-project",
			});
			await registerPausedOwnedRun(backend, RELEASE_RUN_C, "session-z", { name: "someone-elses" });
			const scope = {};
			const first = await startSwitchedSession(scope, "session-a", "startup");
			await first.get("session_shutdown")!({ reason });
			const notices: string[] = [];
			await startSwitchedSession(scope, "session-b", reason, notifyingUi(notices));
			assert.equal(notices.length, 1, notices.join("\n---\n"));
			assert.match(notices[0]!, new RegExp(`/workflow resume ${RELEASE_RUN_A}\\b`));
			assert.match(notices[0]!, /alpha/);
			assert.doesNotMatch(notices[0]!, new RegExp(RELEASE_RUN_B));
			assert.doesNotMatch(notices[0]!, new RegExp(RELEASE_RUN_C));
		});
	}

	test("the notice is not repeated after the successor reloads, and is absent on reload and startup (#3569)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerPausedOwnedRun(backend, RELEASE_RUN_A, "session-a");
		const scope = {};
		const first = await startSwitchedSession(scope, "session-a", "startup");
		await first.get("session_shutdown")!({ reason: "reload" });
		const reloaded: string[] = [];
		const second = await startSwitchedSession(scope, "session-a", "reload", notifyingUi(reloaded));
		assert.deepEqual(reloaded, []);
		await second.get("session_shutdown")!({ reason: "new" });
		const switched: string[] = [];
		const third = await startSwitchedSession(scope, "session-b", "new", notifyingUi(switched));
		assert.equal(switched.length, 1);
		await third.get("session_shutdown")!({ reason: "reload" });
		const afterReload: string[] = [];
		await startSwitchedSession(scope, "session-b", "reload", notifyingUi(afterReload));
		assert.deepEqual(afterReload, []);
		const started: string[] = [];
		await startSwitchedSession({}, "session-c", "startup", notifyingUi(started));
		assert.deepEqual(started, []);
	});

	test("a reload in the successor keeps unadopted released runs for the next successor's notice (#3569)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerPausedOwnedRun(backend, RELEASE_RUN_A, "session-a");
		const scope = {};
		const first = await startSwitchedSession(scope, "session-a", "startup");
		await first.get("session_shutdown")!({ reason: "new" });
		const announced: string[] = [];
		const second = await startSwitchedSession(scope, "session-b", "new", notifyingUi(announced));
		assert.equal(announced.length, 1);
		await second.get("session_shutdown")!({ reason: "reload" });
		const reloaded: string[] = [];
		const third = await startSwitchedSession(scope, "session-b", "reload", notifyingUi(reloaded));
		assert.deepEqual(reloaded, [], "a reload does not repeat the notice");
		await third.get("session_shutdown")!({ reason: "new" });
		const next: string[] = [];
		await startSwitchedSession(scope, "session-c", "new", notifyingUi(next));
		assert.equal(next.length, 1, "the next successor is still told about the unadopted run");
		assert.match(next[0]!, new RegExp(RELEASE_RUN_A));
	});

	test("the notice omits a released run another session adopted first (#3569)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerPausedOwnedRun(backend, RELEASE_RUN_A, "session-a");
		await registerPausedOwnedRun(backend, RELEASE_RUN_B, "session-a");
		const scope = {};
		const first = await startSwitchedSession(scope, "session-a", "startup");
		await first.get("session_shutdown")!({ reason: "new" });
		assert.equal(
			await backend.commitWorkflowStatusTransition(
				RELEASE_RUN_A,
				["paused"],
				"running",
				undefined,
				undefined,
				undefined,
				"session-c",
			),
			true,
		);
		const notices: string[] = [];
		await startSwitchedSession(scope, "session-b", "new", notifyingUi(notices));
		assert.equal(notices.length, 1);
		assert.doesNotMatch(notices[0]!, new RegExp(RELEASE_RUN_A));
		assert.match(notices[0]!, new RegExp(RELEASE_RUN_B));
	});

	test("a headless successor starts without a notice or an error and can still adopt the run (#3569)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerPausedOwnedRun(backend, RELEASE_RUN_A, "session-a");
		const scope = {};
		const first = await startSwitchedSession(scope, "session-a", "startup", { hasUI: false });
		await first.get("session_shutdown")!({ reason: "fork" });
		await startSwitchedSession(scope, "session-b", "fork", { hasUI: false });
		assert.equal(backend.getWorkflow(RELEASE_RUN_A)?.releasedModelOwner, "session-a");
	});

	test("nothing is released or announced when the previous session owned no paused runs (#3569)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		const scope = {};
		const first = await startSwitchedSession(scope, "session-a", "startup");
		await first.get("session_shutdown")!({ reason: "new" });
		const notices: string[] = [];
		await startSwitchedSession(scope, "session-b", "new", notifyingUi(notices));
		assert.deepEqual(notices, []);
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
	test("drops detached handles, retains controlling ones, and prunes emptied run maps", async () => {
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

describe("quit pauses and clears without closing the shared journal", () => {
	test("session_shutdown(quit) pauses the run and clears every handle once", async () => {
		const backend = await readyDurability();
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
		assert.equal(getDurableBackend(), backend);
		assert.ok(await backend.prepareWorkflowCatalog());
	});

	for (const reason of PRESERVE) {
		test(`session_shutdown(${reason}) keeps the shared journal open`, async () => {
			const backend = await readyDurability();
			const shutdown = captureHandlers().get("session_shutdown");
			assert.ok(shutdown);
			await shutdown({ reason });
			assert.equal(getDurableBackend(), backend);
			assert.ok(await backend.prepareWorkflowCatalog());
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

		test(`${reason} in a headless host proceeds without consulting its no-op confirm (#3203)`, async () => {
			startBareRun(`no-ui-${reason}`, "switch-no-ui");
			const handler = captureHandlers().get(event);
			assert.ok(handler);
			let asked = false;
			const result = await handler(
				{ reason, entryId: "e1", position: "before" },
				{
					hasUI: false,
					ui: {
						confirm: async () => {
							asked = true;
							return false;
						},
					},
				},
			);
			assert.equal(result, undefined);
			assert.equal(asked, false);
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

	test("confirmation copy uses singular wording for one run (#3203)", async () => {
		assert.deepEqual(sessionSwitchQuitConfirmation("new", 1), {
			title: "Quit 1 running workflow and start a new session?",
			message:
				"Continuing quits 1 running workflow now. It stops at its last checkpoint and can be resumed later with /workflow resume.",
		});
	});
});

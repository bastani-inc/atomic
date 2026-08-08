/**
 * W8: what a replacement session reports for top-level workflow runs.
 *
 * These tests drive the real workflows session handlers — `session_shutdown`
 * then `session_start`, never `setNotificationsActive` directly — and a real
 * `HerdrReporter` over a recording transport, so what they assert is the pane
 * state a pane would actually receive.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "vitest";
import { createEventBus, type EventBusController } from "../../packages/coding-agent/src/core/event-bus.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import {
	getWorkflowLifecycleBridgeSnapshot,
	isWorkflowLifecycleBridgeEvent,
	resetWorkflowLifecycleBridgeSnapshot,
	WORKFLOW_LIFECYCLE_EVENT,
	type WorkflowLifecycleBridgeEvent,
} from "../../packages/coding-agent/src/core/workflow-lifecycle-events.js";
import { HerdrReporter } from "../../packages/coding-agent/src/extensions/herdr/reporter.js";
import type { HerdrRequest } from "../../packages/coding-agent/src/extensions/herdr/types.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { createInMemoryTestBackend, setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { registerWorkflowLifecycleHandlers } from "../../packages/workflows/src/extension/extension-lifecycle.js";
import { createWorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

const PANE_ID = "pane-w8";

/**
 * Every process-preserving replacement reason. All four keep this session's
 * workflows running, so all four must report a still-live run.
 */
const ALL_REASONS = ["reload", "new", "resume", "fork"] as const;

type SessionHandler = (event: object, ctx?: object) => Promise<void> | void;

interface WorkflowSession {
	sessionStart(reason: string): Promise<void>;
	sessionShutdown(reason: string): Promise<void>;
}

/** One workflows extension instance bound to a shared host event bus. */
function createWorkflowSession(bus: EventBusController): WorkflowSession {
	const handlers = new Map<string, SessionHandler>();
	const pi = {
		events: bus,
		disableAsyncDiscovery: true,
		on(type: string, handler: SessionHandler) {
			handlers.set(type, handler);
		},
	} as ExtensionAPI;
	const runtimeState = createWorkflowExtensionRuntimeState(pi, {} as never);
	registerWorkflowLifecycleHandlers(pi, {
		runtimeState,
		storeWidgetRef: { current: null },
		intercomControlRef: { current: null },
	});
	const invoke = async (type: string, reason: string): Promise<void> => {
		const handler = handlers.get(type);
		assert.ok(handler !== undefined, `missing ${type} handler`);
		await handler({ reason }, { hasUI: false });
	};
	return {
		sessionStart: (reason) => invoke("session_start", reason),
		sessionShutdown: (reason) => invoke("session_shutdown", reason),
	};
}

interface RecordingReporter {
	readonly reporter: HerdrReporter;
	states(): Array<{ state: string; message: string | undefined }>;
}

/**
 * A reporter that activates exactly the way the Herdr extension activates one:
 * subscribe to the neutral event, seed from the retained snapshot, then bind.
 */
function activateReporter(bus: EventBusController): RecordingReporter {
	const requests: HerdrRequest[] = [];
	const reporter = new HerdrReporter({
		paneId: PANE_ID,
		transport: async (request) => {
			requests.push(request);
			return true;
		},
	});
	bus.on(WORKFLOW_LIFECYCLE_EVENT, (payload) => {
		if (typeof payload !== "object" || payload === null || !isWorkflowLifecycleBridgeEvent(payload)) return;
		reporter.onWorkflowLifecycle(payload);
	});
	reporter.seedWorkflowLifecycleEvents(getWorkflowLifecycleBridgeSnapshot(bus));
	reporter.onSessionStart(SessionManager.inMemory(), true);
	return {
		reporter,
		states: () =>
			requests
				.filter((request) => request.method === "pane.report_agent")
				.map((request) => ({
					state: String(request.params.state),
					message: request.params.message === undefined ? undefined : String(request.params.message),
				})),
	};
}

/** Every neutral event published from the moment this is called. */
function recordPublished(bus: EventBusController): WorkflowLifecycleBridgeEvent[] {
	const published: WorkflowLifecycleBridgeEvent[] = [];
	bus.on(WORKFLOW_LIFECYCLE_EVENT, (payload) => {
		if (typeof payload === "object" && payload !== null && isWorkflowLifecycleBridgeEvent(payload)) {
			published.push(payload);
		}
	});
	return published;
}

function freshBus(): EventBusController {
	const bus = createEventBus();
	resetWorkflowLifecycleBridgeSnapshot(bus);
	return bus;
}

function startLiveRun(id: string, name: string): void {
	store.recordRunStart({ id, name, inputs: {}, status: "running", stages: [], startedAt: 1 });
}

function awaitInputOnStage(runId: string, stageId: string): void {
	store.recordStageStart(runId, { id: stageId, name: stageId, status: "running", parentIds: [], toolEvents: [] });
	store.recordStageAwaitingInput(runId, stageId, true, 3);
}

function snapshotOf(bus: EventBusController): readonly WorkflowLifecycleBridgeEvent[] {
	return getWorkflowLifecycleBridgeSnapshot(bus);
}

const REAL_EXECUTOR_REPLACEMENT_TIMEOUT_MS = 60_000;

async function waitForAwaitingInputStage(runId: string): Promise<StageSnapshot> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const run = store.runs().find((candidate) => candidate.id === runId);
		const stage = run?.stages.find((candidate) => candidate.status === "awaiting_input");
		if (stage !== undefined) return stage;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`run ${runId} did not reach an awaiting-input stage`);
}

function realAwaitingInputWorkflow() {
	return workflow({
		name: "replacement-awaiting-input",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.ui.confirm("Approve this workflow?");
			return {};
		},
	});
}

describe("workflow lifecycle bridge across session replacement", () => {
	beforeEach(() => {
		store.clear();
		stageControlRegistry.clear();
		setDurableBackend(createInMemoryTestBackend());
	});

	afterEach(() => {
		stageControlRegistry.clear();
		store.clear();
		setDurableBackend(undefined);
	});

	for (const reason of ALL_REASONS) {
		test(
			`a real executor stage survives ${reason} predecessor shutdown and successor start`,
			async () => {
				const bus = freshBus();
				const predecessor = createWorkflowSession(bus);
				await predecessor.sessionStart("startup");
				const runId = `real-${reason}-run`;
				const controller = new AbortController();
				const execution = run(
					realAwaitingInputWorkflow(),
					{},
					{
						runId,
						store,
						signal: controller.signal,
						stageControlRegistry,
						usePromptNodesForUi: true,
					},
				);
				try {
					const stageBeforeShutdown = await waitForAwaitingInputStage(runId);
					const handle = stageControlRegistry.get(runId, stageBeforeShutdown.id);
					assert.ok(handle, "the real executor must register its live stage handle");
					assert.equal(handle.status, "awaiting_input");
					assert.equal(stageControlRegistry.run(runId).stages().length, 1);

					await predecessor.sessionShutdown(reason);
					const stageAfterShutdown = store
						.runs()
						.find((candidate) => candidate.id === runId)
						?.stages.find((candidate) => candidate.id === stageBeforeShutdown.id);
					assert.equal(stageAfterShutdown?.status, "awaiting_input");
					assert.equal(stageControlRegistry.get(runId, stageBeforeShutdown.id), handle);

					const successor = createWorkflowSession(bus);
					await successor.sessionStart(reason);
					const stageAfterStart = store
						.runs()
						.find((candidate) => candidate.id === runId)
						?.stages.find((candidate) => candidate.id === stageBeforeShutdown.id);
					assert.equal(stageAfterStart?.status, "awaiting_input");
					assert.equal(handle.status, "awaiting_input");

					const replacement = activateReporter(bus);
					await replacement.reporter.drain();
					assert.deepEqual(replacement.states().at(-1), {
						state: "blocked",
						message: "replacement-awaiting-input: confirm",
					});
				} finally {
					controller.abort(new Error("replacement test cleanup"));
					await execution;
				}
			},
			REAL_EXECUTOR_REPLACEMENT_TIMEOUT_MS,
		);
	}

	for (const reason of ALL_REASONS) {
		test(`a live run keeps its contribution through a ${reason} shutdown`, async () => {
			const bus = freshBus();
			const predecessor = createWorkflowSession(bus);
			await predecessor.sessionStart("startup");
			startLiveRun("run-across-boundary", "deploy");
			assert.deepEqual(snapshotOf(bus), [{ runKey: "run-across-boundary", kind: "started", label: "deploy" }]);

			await predecessor.sessionShutdown(reason);

			// The run is still live; the shutdown must not have wiped what the pane
			// needs to keep showing it.
			assert.equal(store.runs().length, 1);
			assert.deepEqual(snapshotOf(bus), [{ runKey: "run-across-boundary", kind: "started", label: "deploy" }]);

			// A reporter that activates in this window reports the live run.
			const replacement = activateReporter(bus);
			await replacement.reporter.drain();
			assert.deepEqual(replacement.states().at(-1), { state: "working", message: undefined });
		});
	}

	for (const reason of ALL_REASONS) {
		test(`a real ${reason} successor start reports a still-live run as working`, async () => {
			const bus = freshBus();
			const predecessor = createWorkflowSession(bus);
			await predecessor.sessionStart("startup");
			startLiveRun("run-still-live", "deploy");
			await predecessor.sessionShutdown(reason);

			const successor = createWorkflowSession(bus);
			await successor.sessionStart(reason);

			assert.equal(store.runs().length, 1, "a process-preserving replacement keeps the run");
			assert.equal(store.runs()[0]?.endedAt, undefined, "the run is still live, not killed");
			const replacement = activateReporter(bus);
			await replacement.reporter.drain();
			assert.deepEqual(replacement.states().at(-1), { state: "working", message: undefined });
			assert.deepEqual(snapshotOf(bus), [{ runKey: "run-still-live", kind: "started", label: "deploy" }]);
		});

		test(`a real ${reason} successor start reports a waiting run as blocked`, async () => {
			const bus = freshBus();
			const predecessor = createWorkflowSession(bus);
			await predecessor.sessionStart("startup");
			startLiveRun("run-waiting", "deploy");
			awaitInputOnStage("run-waiting", "approval");
			await predecessor.sessionShutdown(reason);

			const successor = createWorkflowSession(bus);
			await successor.sessionStart(reason);

			const replacement = activateReporter(bus);
			await replacement.reporter.drain();
			assert.deepEqual(replacement.states().at(-1), { state: "blocked", message: "deploy: approval" });
		});

		test(`a run preserved through ${reason} is still answerable in the successor`, async () => {
			const bus = freshBus();
			const predecessor = createWorkflowSession(bus);
			await predecessor.sessionStart("startup");
			startLiveRun("run-answerable", "deploy");
			store.recordStageStart("run-answerable", {
				id: "approval",
				name: "approval",
				status: "running",
				parentIds: [],
				toolEvents: [],
			});
			const pendingPrompt = { id: "prompt-1", kind: "confirm", message: "Ship it?", createdAt: 3 } as const;
			store.recordStagePendingPrompt("run-answerable", "approval", pendingPrompt);
			await predecessor.sessionShutdown(reason);

			const successor = createWorkflowSession(bus);
			await successor.sessionStart(reason);

			// The prompt survives as state, not just as a pane label: the successor
			// can still answer it, and the pane follows the run back to working.
			const replacement = activateReporter(bus);
			await replacement.reporter.drain();
			assert.deepEqual(replacement.states().at(-1), { state: "blocked", message: "deploy: approval" });

			// Answering it through the store is what proves the run survived as
			// state rather than only as a pane label.
			assert.equal(
				store.resolveStagePendingPrompt("run-answerable", "approval", "prompt-1", true),
				true,
				"a preserved prompt must still be answerable after the successor starts",
			);
			store.recordStageAwaitingInput("run-answerable", "approval", false, 5);
			await replacement.reporter.drain();
			assert.deepEqual(replacement.states().at(-1), { state: "working", message: undefined });
		});
	}

	for (const reason of ALL_REASONS) {
		test(`a real ${reason} successor start does not resurrect a run that died first`, async () => {
			const bus = freshBus();
			const predecessor = createWorkflowSession(bus);
			await predecessor.sessionStart("startup");
			startLiveRun("run-dead", "deploy");
			await predecessor.sessionShutdown(reason);

			// The pane is showing the run when the successor takes over.
			const replacement = activateReporter(bus);
			await replacement.reporter.drain();
			assert.deepEqual(replacement.states().at(-1), { state: "working", message: undefined });

			// It dies in the handoff window, after the predecessor stopped observing it.
			store.recordRunEnd("run-dead", "killed", undefined, "workflow killed");
			const published = recordPublished(bus);

			const successor = createWorkflowSession(bus);
			await successor.sessionStart(reason);
			await replacement.reporter.drain();

			// The retained contribution is dropped, never completed.
			assert.deepEqual(published, [{ runKey: "run-dead", kind: "quit", label: "deploy" }]);
			assert.equal(
				published.some((event) => event.kind === "completed"),
				false,
			);
			assert.deepEqual(snapshotOf(bus), []);
			assert.deepEqual(replacement.states().at(-1), { state: "idle", message: undefined });
		});
	}

	test("a run reusing a retired id after a session boundary starts fresh", async () => {
		const bus = freshBus();
		const predecessor = createWorkflowSession(bus);
		await predecessor.sessionStart("startup");
		startLiveRun("recycled-id", "deploy");
		store.recordRunEnd("recycled-id", "completed", {});
		assert.deepEqual(snapshotOf(bus), []);
		// The finished run is compacted out of the store; only the tombstone the
		// bridge handed over still mentions its id.
		store.removeRun("recycled-id");
		await predecessor.sessionShutdown("new");

		const successor = createWorkflowSession(bus);
		await successor.sessionStart("new");

		const published = recordPublished(bus);
		startLiveRun("recycled-id", "deploy");
		assert.deepEqual(published, [{ runKey: "recycled-id", kind: "started", label: "deploy" }]);
	});
});

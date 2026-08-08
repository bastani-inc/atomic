/**
 * W8: what a replacement session reports for top-level workflow runs.
 *
 * These tests drive the real workflows session handlers — `session_shutdown`
 * then `session_start`, never `setNotificationsActive` directly — and a real
 * `HerdrReporter` over a recording transport, so what they assert is the pane
 * state a pane would actually receive.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "vitest";
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
import { registerWorkflowLifecycleHandlers } from "../../packages/workflows/src/extension/extension-lifecycle.js";
import { createWorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import { store } from "../../packages/workflows/src/shared/store.js";

const PANE_ID = "pane-w8";

/**
 * Replacement reasons that keep this session's workflows running.
 *
 * `new` and `resume` ask the user first and stop the workflows they agreed to
 * stop, so their correct successor state is idle rather than a live run.
 */
const KEEPS_WORKFLOWS = ["reload", "fork"] as const;
const STOPS_WORKFLOWS = ["new", "resume"] as const;
const ALL_REASONS = [...KEEPS_WORKFLOWS, ...STOPS_WORKFLOWS] as const;

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

describe("workflow lifecycle bridge across session replacement", () => {
	beforeEach(() => {
		store.clear();
	});

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

	for (const reason of KEEPS_WORKFLOWS) {
		test(`a real ${reason} successor start reports a still-live run as working`, async () => {
			const bus = freshBus();
			const predecessor = createWorkflowSession(bus);
			await predecessor.sessionStart("startup");
			startLiveRun("run-still-live", "deploy");
			await predecessor.sessionShutdown(reason);

			const successor = createWorkflowSession(bus);
			await successor.sessionStart(reason);

			assert.equal(store.runs().length, 1, "a process-preserving replacement keeps the run");
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
	}

	for (const reason of STOPS_WORKFLOWS) {
		test(`a real ${reason} successor start drops the runs the user agreed to stop`, async () => {
			const bus = freshBus();
			const predecessor = createWorkflowSession(bus);
			await predecessor.sessionStart("startup");
			startLiveRun("run-stopped-at-boundary", "deploy");
			awaitInputOnStage("run-stopped-at-boundary", "approval");
			await predecessor.sessionShutdown(reason);

			// The pane is showing the run when the successor takes over.
			const replacement = activateReporter(bus);
			await replacement.reporter.drain();
			assert.deepEqual(replacement.states().at(-1), { state: "blocked", message: "deploy: approval" });

			const published = recordPublished(bus);
			const successor = createWorkflowSession(bus);
			await successor.sessionStart(reason);
			await replacement.reporter.drain();

			// The drop repeats the label already on the wire; it never claims completion.
			assert.deepEqual(published, [{ runKey: "run-stopped-at-boundary", kind: "quit", label: "deploy: approval" }]);
			assert.equal(
				published.some((event) => event.kind === "completed"),
				false,
			);
			assert.deepEqual(snapshotOf(bus), []);
			assert.deepEqual(replacement.states().at(-1), { state: "idle", message: undefined });
		});
	}

	for (const reason of ALL_REASONS) {
		test(`a real ${reason} successor start does not resurrect a run that died first`, async () => {
			const bus = freshBus();
			const predecessor = createWorkflowSession(bus);
			await predecessor.sessionStart("startup");
			startLiveRun("run-dead", "deploy");
			await predecessor.sessionShutdown(reason);
			// Dies in the window, after the predecessor stopped observing it.
			store.recordRunEnd("run-dead", "killed", undefined, "workflow killed");

			const successor = createWorkflowSession(bus);
			await successor.sessionStart(reason);

			const replacement = activateReporter(bus);
			await replacement.reporter.drain();
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
		await predecessor.sessionShutdown("new");

		const successor = createWorkflowSession(bus);
		await successor.sessionStart("new");

		const published = recordPublished(bus);
		startLiveRun("recycled-id", "deploy");
		assert.deepEqual(published, [{ runKey: "recycled-id", kind: "started", label: "deploy" }]);
	});
});

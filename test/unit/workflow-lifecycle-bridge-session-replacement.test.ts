/**
 * W8: what a replacement session reports for top-level workflow runs.
 *
 * These tests drive the real workflows session handlers and a real
 * `HerdrReporter` over a recording transport, so what they assert is the pane
 * state a pane would actually receive — not a prepopulated bridge snapshot.
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
import {
	createWorkflowExtensionRuntimeState,
	type WorkflowExtensionRuntimeState,
} from "../../packages/workflows/src/extension/extension-runtime-state.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import { store } from "../../packages/workflows/src/shared/store.js";

const PANE_ID = "pane-w8";

type SessionHandler = (event: object, ctx?: object) => Promise<void> | void;

interface WorkflowSession {
	readonly runtimeState: WorkflowExtensionRuntimeState;
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
		runtimeState,
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

function startLiveRun(id: string, name: string): void {
	store.recordRunStart({ id, name, inputs: {}, status: "running", stages: [], startedAt: 1 });
}

function snapshotOf(bus: EventBusController): readonly WorkflowLifecycleBridgeEvent[] {
	return getWorkflowLifecycleBridgeSnapshot(bus);
}

describe("workflow lifecycle bridge across session replacement", () => {
	beforeEach(() => {
		store.clear();
	});

	test("a live run keeps its contribution through the predecessor's shutdown", async () => {
		const bus = createEventBus();
		resetWorkflowLifecycleBridgeSnapshot(bus);
		const predecessor = createWorkflowSession(bus);
		await predecessor.sessionStart("reload");
		startLiveRun("run-across-reload", "deploy");
		assert.deepEqual(snapshotOf(bus), [{ runKey: "run-across-reload", kind: "started", label: "deploy" }]);

		await predecessor.sessionShutdown("reload");

		// The run is still live; the shutdown must not have wiped what the pane
		// needs to keep showing it.
		assert.equal(store.runs().length, 1);
		assert.deepEqual(snapshotOf(bus), [{ runKey: "run-across-reload", kind: "started", label: "deploy" }]);

		// A reporter that activates in this window reports the live run.
		const replacement = activateReporter(bus);
		await replacement.reporter.drain();
		assert.deepEqual(replacement.states().at(-1), { state: "working", message: undefined });
	});

	test("a successor start drops a run it can no longer observe", async () => {
		const bus = createEventBus();
		resetWorkflowLifecycleBridgeSnapshot(bus);
		const predecessor = createWorkflowSession(bus);
		await predecessor.sessionStart("reload");
		startLiveRun("run-killed-at-boundary", "deploy");
		await predecessor.sessionShutdown("reload");

		// The pane is showing the run when the successor takes over.
		const replacement = activateReporter(bus);
		await replacement.reporter.drain();
		assert.deepEqual(replacement.states().at(-1), { state: "working", message: undefined });

		const published: WorkflowLifecycleBridgeEvent[] = [];
		bus.on(WORKFLOW_LIFECYCLE_EVENT, (payload) => {
			if (typeof payload === "object" && payload !== null && isWorkflowLifecycleBridgeEvent(payload)) {
				published.push(payload);
			}
		});

		// The real successor start kills in-flight runs and clears the store.
		const successor = createWorkflowSession(bus);
		await successor.sessionStart("reload");
		await replacement.reporter.drain();

		assert.deepEqual(published, [{ runKey: "run-killed-at-boundary", kind: "quit", label: "deploy" }]);
		assert.equal(
			published.some((event) => event.kind === "completed"),
			false,
		);
		assert.deepEqual(snapshotOf(bus), []);
		assert.deepEqual(replacement.states().at(-1), { state: "idle", message: undefined });
	});

	test("a successor reconstructs working and blocked state from the store it observes", async () => {
		const bus = createEventBus();
		resetWorkflowLifecycleBridgeSnapshot(bus);
		const predecessor = createWorkflowSession(bus);
		await predecessor.sessionStart("reload");
		startLiveRun("run-still-live", "deploy");
		await predecessor.sessionShutdown("reload");

		// The successor's bridge installs against the store as it actually is.
		const successor = createWorkflowSession(bus);
		successor.runtimeState.setNotificationsActive(true);

		const replacement = activateReporter(bus);
		await replacement.reporter.drain();
		assert.deepEqual(replacement.states().at(-1), { state: "working", message: undefined });
		assert.deepEqual(snapshotOf(bus), [{ runKey: "run-still-live", kind: "started", label: "deploy" }]);

		// The successor's own bridge, not the predecessor's, drives what follows.
		store.recordStageStart("run-still-live", {
			id: "approval",
			name: "approval",
			status: "running",
			parentIds: [],
			toolEvents: [],
		});
		store.recordStageAwaitingInput("run-still-live", "approval", true, 3);
		await replacement.reporter.drain();
		assert.deepEqual(replacement.states().at(-1), { state: "blocked", message: "deploy: approval" });
	});

	test("a successor start does not resurrect a predecessor's dead run", async () => {
		const bus = createEventBus();
		resetWorkflowLifecycleBridgeSnapshot(bus);
		const predecessor = createWorkflowSession(bus);
		await predecessor.sessionStart("reload");
		startLiveRun("run-completed", "deploy");
		store.recordRunEnd("run-completed", "completed", {});
		assert.deepEqual(snapshotOf(bus), []);
		await predecessor.sessionShutdown("reload");

		const successor = createWorkflowSession(bus);
		await successor.sessionStart("reload");

		const replacement = activateReporter(bus);
		await replacement.reporter.drain();
		assert.deepEqual(snapshotOf(bus), []);
		assert.deepEqual(replacement.states().at(-1), { state: "idle", message: undefined });
	});
});

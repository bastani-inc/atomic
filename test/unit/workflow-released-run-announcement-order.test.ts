import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import type { DurableWorkflowHandle } from "../../packages/workflows/src/durable/types.js";
import { registerWorkflowLifecycleHandlers } from "../../packages/workflows/src/extension/extension-lifecycle.js";
import type { WorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";
import { createWorkflowHilAnswerNotificationState } from "../../packages/workflows/src/extension/hil-answer-notifications.js";
import { createWorkflowLifecycleNotificationState } from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import {
	adoptStageControlRegistry,
	stageControlRegistry,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { adoptStore } from "../../packages/workflows/src/shared/store-factory.js";
import { sleep } from "../helpers/runtime.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

/** Runs whose adoptability check waits for the test to let it finish. */
const heldAdoptabilityChecks = vi.hoisted(() => ({
	runs: new Set<string>(),
	release: Promise.withResolvers<void>(),
	entered: new Set<string>(),
}));

vi.mock("../../packages/workflows/src/durable/sdk-recovery-scope.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../packages/workflows/src/durable/sdk-recovery-scope.js")>();
	return {
		...actual,
		async isSdkReleasedRunAdoptableAsync(handle: DurableWorkflowHandle, cwd: string | undefined) {
			if (heldAdoptabilityChecks.runs.has(handle.workflowId)) {
				heldAdoptabilityChecks.entered.add(handle.workflowId);
				await heldAdoptabilityChecks.release.promise;
			}
			return actual.isSdkReleasedRunAdoptableAsync(handle, cwd);
		},
	};
});

type SessionEventHandler = (event?: unknown, ctx?: unknown) => Promise<unknown>;

const FIRST_RELEASED_RUN = "11111111-1111-4111-8111-111111111111";
const SECOND_RELEASED_RUN = "22222222-2222-4222-8222-222222222222";
/** Long enough for a successor that does not wait for the earlier announcement to finish its own. */
const SUCCESSOR_SETTLE_MS = 50;

beforeEach(() => {
	const scope = createEventBus();
	adoptStore(scope);
	adoptStageControlRegistry(scope);
	stageControlRegistry.clear();
	store.clear();
	heldAdoptabilityChecks.runs.clear();
	heldAdoptabilityChecks.entered.clear();
	heldAdoptabilityChecks.release = Promise.withResolvers<void>();
});

afterEach(() => {
	heldAdoptabilityChecks.release.resolve();
	stageControlRegistry.clear();
	store.clear();
	setDurableBackend(undefined);
});

function captureHandlers(lifecycleScope: object): Map<string, SessionEventHandler> {
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
			intercomControlRef: { current: null },
		},
	);
	return handlers;
}

function registerPausedOwnedRun(backend: DurableWorkflowBackend, runId: string, modelOwner: string): Promise<void> {
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
	});
}

function startSession(
	scope: object,
	sessionId: string,
	reason: string,
	notices: string[],
): { handlers: Map<string, SessionEventHandler>; started: Promise<unknown> } {
	const handlers = captureHandlers(scope);
	const started = handlers.get("session_start")!(
		{ reason },
		{
			sessionManager: { getSessionId: () => sessionId },
			cwd: process.cwd(),
			ui: { notify: (message: string) => notices.push(message), setWidget() {}, requestRender() {} },
		},
	);
	return { handlers, started };
}

test("a switch while the previous session still checks its released runs announces every released run (#5377)", async () => {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	await registerPausedOwnedRun(backend, FIRST_RELEASED_RUN, "session-a");
	await registerPausedOwnedRun(backend, SECOND_RELEASED_RUN, "session-b");
	const scope = {};

	const first = startSession(scope, "session-a", "startup", []);
	await first.started;
	await first.handlers.get("session_shutdown")!({ reason: "new" });
	assert.equal(backend.getWorkflow(FIRST_RELEASED_RUN)?.releasedModelOwner, "session-a");

	heldAdoptabilityChecks.runs.add(FIRST_RELEASED_RUN);
	const secondNotices: string[] = [];
	const second = startSession(scope, "session-b", "new", secondNotices);
	await vi.waitFor(() => assert.ok(heldAdoptabilityChecks.entered.has(FIRST_RELEASED_RUN)));

	const thirdNotices: string[] = [];
	const third = startSession(scope, "session-c", "new", thirdNotices);
	await vi.waitFor(() => assert.equal(backend.getWorkflow(SECOND_RELEASED_RUN)?.releasedModelOwner, "session-b"));
	await sleep(SUCCESSOR_SETTLE_MS);
	heldAdoptabilityChecks.release.resolve();
	await Promise.all([second.started, third.started]);

	assert.equal(thirdNotices.length, 1, thirdNotices.join("\n---\n"));
	assert.match(thirdNotices[0]!, new RegExp(`/resume ${FIRST_RELEASED_RUN}\\b`));
	assert.match(thirdNotices[0]!, new RegExp(`/resume ${SECOND_RELEASED_RUN}\\b`));
	assert.deepEqual(
		secondNotices,
		[],
		"a session another switch replaced does not announce runs to its successor's UI",
	);

	await third.handlers.get("session_shutdown")!({ reason: "new" });
	const fourthNotices: string[] = [];
	await startSession(scope, "session-d", "new", fourthNotices).started;
	assert.equal(fourthNotices.length, 1, "the next successor is still told about both unadopted runs");
	assert.match(fourthNotices[0]!, new RegExp(`/resume ${FIRST_RELEASED_RUN}\\b`));
	assert.match(fourthNotices[0]!, new RegExp(`/resume ${SECOND_RELEASED_RUN}\\b`));
});

test("a reload while the switched-to session still checks its released runs announces them after the reload (#5377)", async () => {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	await registerPausedOwnedRun(backend, FIRST_RELEASED_RUN, "session-a");
	const scope = {};

	const first = startSession(scope, "session-a", "startup", []);
	await first.started;
	await first.handlers.get("session_shutdown")!({ reason: "new" });

	heldAdoptabilityChecks.runs.add(FIRST_RELEASED_RUN);
	const switchedNotices: string[] = [];
	const switched = startSession(scope, "session-b", "new", switchedNotices);
	await vi.waitFor(() => assert.ok(heldAdoptabilityChecks.entered.has(FIRST_RELEASED_RUN)));
	await switched.handlers.get("session_shutdown")!({ reason: "reload" });
	const reloadedNotices: string[] = [];
	const reloaded = startSession(scope, "session-b", "reload", reloadedNotices);
	heldAdoptabilityChecks.runs.clear();
	heldAdoptabilityChecks.release.resolve();
	await Promise.all([switched.started, reloaded.started]);

	assert.equal(reloadedNotices.length, 1, reloadedNotices.join("\n---\n"));
	assert.match(reloadedNotices[0]!, new RegExp(`/resume ${FIRST_RELEASED_RUN}\\b`));
	assert.deepEqual(switchedNotices, [], "the context the reload replaced is not used for the notice");

	await reloaded.handlers.get("session_shutdown")!({ reason: "reload" });
	const reloadedAgain: string[] = [];
	await startSession(scope, "session-b", "reload", reloadedAgain).started;
	assert.deepEqual(reloadedAgain, [], "a second reload does not repeat the notice");
});

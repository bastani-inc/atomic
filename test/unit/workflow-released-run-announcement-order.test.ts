import assert from "node:assert/strict";
import { promiseHooks } from "node:v8";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import {
	getExtensionContextOwner,
	retireExtensionContextEffects,
} from "../../packages/coding-agent/src/core/extensions/runner-context.js";
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
/** Far past the time a session start waits for one adoptability check, and far below the test timeout. */
const START_DEADLINE_MS = 15_000;
/** A session start's wait for a hung adoptability check, then the rest of its start, with headroom. */
const HUNG_CHECK_TEST_TIMEOUT_MS = 60_000;
const THIRD_RELEASED_RUN = "33333333-3333-4333-8333-333333333333";
/** Starts that wait on one hung check before and after the measured ones. */
const FEW_WAITING_STARTS = 2;
const MANY_WAITING_STARTS = 8;
/** Promises a start may leave pending for reasons other than the hung check. */
const PENDING_PROMISE_SLACK = 2;
/** Sequential starts that each may wait out a hung check, with headroom. */
const WAITING_STARTS_TEST_TIMEOUT_MS = 90_000;

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

interface StartedSession {
	readonly handlers: Map<string, SessionEventHandler>;
	readonly started: Promise<unknown>;
	/** Retires this session's context the way the host does when another session replaces it. */
	retire(): void;
}

function startSession(scope: object, sessionId: string, reason: string, notices: string[]): StartedSession {
	const handlers = captureHandlers(scope);
	let retired = false;
	const live = () => {
		if (retired) throw new Error("This extension context is no longer active");
	};
	const context = {
		sessionManager: { getSessionId: () => sessionId },
		get cwd() {
			live();
			return process.cwd();
		},
		ui: {
			notify: (message: string) => {
				live();
				notices.push(message);
			},
			setWidget() {},
			requestRender() {},
		},
	};
	const started = handlers.get("session_start")!({ reason }, context);
	return {
		handlers,
		started,
		retire() {
			retireExtensionContextEffects(getExtensionContextOwner(context));
			retired = true;
		},
	};
}

/** Settles with whether `started` settled within {@link START_DEADLINE_MS}, leaving no timer or promise pending. */
async function settlesInTime(started: Promise<unknown>): Promise<boolean> {
	const late = Promise.withResolvers<false>();
	const timer = setTimeout(() => late.resolve(false), START_DEADLINE_MS);
	try {
		return await Promise.race([started.then(() => true), late.promise]);
	} finally {
		clearTimeout(timer);
		late.resolve(false);
	}
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

test(
	"a hung adoption check holds no later session start, and the newest start announces every run it could check (#5377)",
	async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerPausedOwnedRun(backend, FIRST_RELEASED_RUN, "session-a");
		await registerPausedOwnedRun(backend, SECOND_RELEASED_RUN, "session-b");
		const scope = {};

		const first = startSession(scope, "session-a", "startup", []);
		await first.started;
		await first.handlers.get("session_shutdown")!({ reason: "new" });

		heldAdoptabilityChecks.runs.add(FIRST_RELEASED_RUN);
		const second = startSession(scope, "session-b", "new", []);
		await vi.waitFor(() => assert.ok(heldAdoptabilityChecks.entered.has(FIRST_RELEASED_RUN)));

		const thirdNotices: string[] = [];
		const third = startSession(scope, "session-c", "new", thirdNotices);
		assert.equal(await settlesInTime(third.started), true, "a later start finishes while the check hangs");
		assert.equal(thirdNotices.length, 1, thirdNotices.join("\n---\n"));
		assert.match(thirdNotices[0]!, new RegExp(`/resume ${SECOND_RELEASED_RUN}\\b`));
		assert.doesNotMatch(thirdNotices[0]!, new RegExp(FIRST_RELEASED_RUN), "a run whose check hangs stays pending");

		const reloaded = startSession(scope, "session-c", "reload", []);
		assert.equal(await settlesInTime(reloaded.started), true, "a reload finishes while the check hangs");
		assert.equal(await settlesInTime(second.started), true, "the start that began the check finishes too");

		heldAdoptabilityChecks.runs.clear();
		heldAdoptabilityChecks.release.resolve();
		await reloaded.handlers.get("session_shutdown")!({ reason: "new" });
		const fourthNotices: string[] = [];
		await startSession(scope, "session-d", "new", fourthNotices).started;
		assert.equal(fourthNotices.length, 1, "the next successor is told about every unadopted run");
		assert.match(fourthNotices[0]!, new RegExp(`/resume ${FIRST_RELEASED_RUN}\\b`));
		assert.match(fourthNotices[0]!, new RegExp(`/resume ${SECOND_RELEASED_RUN}\\b`));
	},
	HUNG_CHECK_TEST_TIMEOUT_MS,
);

test("a start that a later switch replaced while it waited keeps every pending run for the newest start (#5377)", async () => {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	await registerPausedOwnedRun(backend, FIRST_RELEASED_RUN, "session-a");
	await registerPausedOwnedRun(backend, SECOND_RELEASED_RUN, "session-b");
	await registerPausedOwnedRun(backend, THIRD_RELEASED_RUN, "session-c");
	const scope = {};

	const first = startSession(scope, "session-a", "startup", []);
	await first.started;
	await first.handlers.get("session_shutdown")!({ reason: "new" });

	heldAdoptabilityChecks.runs.add(FIRST_RELEASED_RUN);
	const secondNotices: string[] = [];
	const second = startSession(scope, "session-b", "new", secondNotices);
	await vi.waitFor(() => assert.ok(heldAdoptabilityChecks.entered.has(FIRST_RELEASED_RUN)));
	const thirdNotices: string[] = [];
	const third = startSession(scope, "session-c", "new", thirdNotices);
	await vi.waitFor(() => assert.equal(backend.getWorkflow(SECOND_RELEASED_RUN)?.releasedModelOwner, "session-b"));

	third.retire();
	const fourthNotices: string[] = [];
	const fourth = startSession(scope, "session-d", "new", fourthNotices);
	await vi.waitFor(() => assert.equal(backend.getWorkflow(THIRD_RELEASED_RUN)?.releasedModelOwner, "session-c"));
	heldAdoptabilityChecks.runs.clear();
	heldAdoptabilityChecks.release.resolve();
	await Promise.all([second.started, third.started, fourth.started]);

	assert.equal(fourthNotices.length, 1, fourthNotices.join("\n---\n"));
	for (const runId of [FIRST_RELEASED_RUN, SECOND_RELEASED_RUN, THIRD_RELEASED_RUN])
		assert.match(fourthNotices[0]!, new RegExp(`/resume ${runId}\\b`));
	assert.deepEqual([...secondNotices, ...thirdNotices], [], "replaced sessions are not told");
});

test(
	"a run whose check timed out stays owed, so the next reload announces it once the check recovers (#5377)",
	async () => {
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
		assert.equal(await settlesInTime(switched.started), true);
		assert.deepEqual(switchedNotices, [], "a run whose check did not finish is not announced yet");

		heldAdoptabilityChecks.runs.clear();
		heldAdoptabilityChecks.release.resolve();
		await switched.handlers.get("session_shutdown")!({ reason: "reload" });
		const reloadedNotices: string[] = [];
		const reloaded = startSession(scope, "session-b", "reload", reloadedNotices);
		await reloaded.started;
		assert.equal(reloadedNotices.length, 1, "the reload gives the notice the switch still owed");
		assert.match(reloadedNotices[0]!, new RegExp(`/resume ${FIRST_RELEASED_RUN}\\b`));

		await reloaded.handlers.get("session_shutdown")!({ reason: "reload" });
		const again: string[] = [];
		await startSession(scope, "session-b", "reload", again).started;
		assert.deepEqual(again, [], "a delivered notice is not repeated");
	},
	HUNG_CHECK_TEST_TIMEOUT_MS,
);

test("the owner that reclaims its run during another session's check is not told the run was released (#5377)", async () => {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	await registerPausedOwnedRun(backend, FIRST_RELEASED_RUN, "session-a");
	const scope = {};

	const owner = startSession(scope, "session-a", "startup", []);
	await owner.started;
	await owner.handlers.get("session_shutdown")!({ reason: "new" });
	assert.equal(backend.getWorkflow(FIRST_RELEASED_RUN)?.releasedModelOwner, "session-a");

	heldAdoptabilityChecks.runs.add(FIRST_RELEASED_RUN);
	const away = startSession(scope, "session-b", "new", []);
	await vi.waitFor(() => assert.ok(heldAdoptabilityChecks.entered.has(FIRST_RELEASED_RUN)));
	await away.handlers.get("session_shutdown")!({ reason: "resume" });
	heldAdoptabilityChecks.runs.clear();
	const returnedNotices: string[] = [];
	const returned = startSession(scope, "session-a", "resume", returnedNotices);
	await vi.waitFor(() => assert.equal(backend.getWorkflow(FIRST_RELEASED_RUN)?.releasedModelOwner, undefined));
	heldAdoptabilityChecks.release.resolve();
	await Promise.all([away.started, returned.started]);

	assert.deepEqual(returnedNotices, [], "the owner is not told about its own reclaimed run");
});

test(
	"session starts waiting on one hung check leave no promise behind for each wait (#5377)",
	async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerPausedOwnedRun(backend, FIRST_RELEASED_RUN, "session-a");
		const scope = {};

		const first = startSession(scope, "session-a", "startup", []);
		await first.started;
		await first.handlers.get("session_shutdown")!({ reason: "new" });
		heldAdoptabilityChecks.runs.add(FIRST_RELEASED_RUN);

		const pending = new Set<Promise<unknown>>();
		const stop = promiseHooks.createHook({
			init: (promise) => pending.add(promise),
			settled: (promise) => pending.delete(promise),
		});
		try {
			let previous = first;
			const pendingAfter: number[] = [];
			for (let index = 1; index <= MANY_WAITING_STARTS; index++) {
				const next = startSession(scope, `session-waiting-${index}`, "new", []);
				assert.equal(await settlesInTime(next.started), true);
				await previous.handlers.get("session_shutdown")!({ reason: "new" }).catch(() => undefined);
				previous = next;
				pendingAfter[index] = pending.size;
			}
			assert.ok(
				pendingAfter[MANY_WAITING_STARTS]! - pendingAfter[FEW_WAITING_STARTS]! <= PENDING_PROMISE_SLACK,
				`pending promises grew with each wait: ${pendingAfter.slice(1).join(", ")}`,
			);
		} finally {
			stop();
		}
	},
	WAITING_STARTS_TEST_TIMEOUT_MS,
);

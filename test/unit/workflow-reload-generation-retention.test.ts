import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { WorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";
import { createWorkflowHilAnswerNotificationState } from "../../packages/workflows/src/extension/hil-answer-notifications.js";
import { createWorkflowLifecycleNotificationState } from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { collectEverythingTracked, trackCollection } from "../helpers/collect-garbage.js";
import { configureCurrentTestStoreBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

type SessionEventHandler = (event?: unknown, ctx?: unknown) => Promise<unknown>;

/**
 * One extension generation of a session, as each load and `/reload` registers it: `/reload` evaluates the extension's
 * modules again, so each generation gets its own copy of them, while the session's state is shared through the host.
 */
async function registerGeneration(
	lifecycleScope: object,
	onApi?: (api: object) => void,
): Promise<{
	handlers: Map<string, SessionEventHandler>;
	runState: { stageControlRegistry: { register(handle: StageControlHandle): void } };
}> {
	vi.resetModules();
	const { registerWorkflowLifecycleHandlers } = await import(
		"../../packages/workflows/src/extension/extension-lifecycle.js"
	);
	const { adoptWorkflowSessionRunState } = await import(
		"../../packages/workflows/src/extension/adopt-session-run-state.js"
	);
	const runState = adoptWorkflowSessionRunState(lifecycleScope, true);
	const handlers = new Map<string, SessionEventHandler>();
	const api = {
		lifecycleScope,
		/** Stands in for everything a real generation's extension API reaches: its runtime, tools and session. */
		retained: Array.from({ length: 10_000 }, (_, index) => `entry ${index}`),
		on: (type: string, handler: SessionEventHandler) => {
			handlers.set(type, handler);
		},
	};
	onApi?.(api);
	registerWorkflowLifecycleHandlers(api as unknown as ExtensionAPI, {
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
		runState,
	});
	return { handlers, runState };
}

function stage(runId: string, onDispose: () => void): StageControlHandle {
	return {
		runId,
		stageId: "stage",
		stageName: "stage",
		status: "running",
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: false,
		messages: [],
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		async pause() {},
		async resume() {
			return undefined;
		},
		subscribe() {
			return () => {};
		},
		dispose: onDispose,
	};
}

test("each /reload's departing extension generation can be collected, and the session's quit still ends the runs it started", async () => {
	configureCurrentTestStoreBackend(await createMemoryTestBackend());
	const sessionScope = {};
	const departed = trackCollection();
	let disposed = false;
	await (async () => {
		const first = await registerGeneration(sessionScope, (api) => departed.track(api));
		first.runState.stageControlRegistry.register(
			stage("started-before-the-reloads", () => {
				disposed = true;
			}),
		);
		await first.handlers.get("session_shutdown")!({ reason: "reload" });
		for (let reload = 0; reload < 4; reload++) {
			const generation = await registerGeneration(sessionScope, (api) => departed.track(api));
			await generation.handlers.get("session_shutdown")!({ reason: "reload" });
		}
	})();
	const current = await registerGeneration(sessionScope);
	await collectEverythingTracked(departed);
	assert.deepEqual(departed.uncollected(), [], "every departed generation was collected");
	await current.handlers.get("session_shutdown")!({ reason: "quit" });
	assert.equal(disposed, true, "the run started before the reloads ended with the session");
});

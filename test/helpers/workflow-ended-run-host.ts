import { setTimeout as delay } from "node:timers/promises";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import type { WorkflowSessionRunState } from "../../packages/workflows/src/extension/adopt-session-run-state.js";
import { registerWorkflowLifecycleHandlers } from "../../packages/workflows/src/extension/extension-lifecycle.js";
import type { WorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";
import { createWorkflowHilAnswerNotificationState } from "../../packages/workflows/src/extension/hil-answer-notifications.js";
import { createWorkflowLifecycleNotificationState } from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { workflowObservationRuntime } from "../../packages/workflows/src/shared/store-factory.js";
import type { WorkflowRuntimeEvent } from "../../packages/workflows/src/shared/workflow-observation-runtime.js";

export type SessionShutdownHandler = (event?: unknown, ctx?: unknown) => Promise<unknown>;

export interface JournalAppendEvent {
	readonly type: string;
	readonly payload: { readonly status?: string };
}

/** A journal whose appends first pass `beforeAppend`; throwing there rejects the append. */
export function journalInterceptingAppend(
	journal: MemoryRunJournal,
	beforeAppend: (event: JournalAppendEvent) => void | Promise<void>,
): MemoryRunJournal {
	return new Proxy(journal, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property);
			if (typeof value !== "function") return value;
			return property === "append"
				? async (...args: unknown[]) => {
						await beforeAppend(args[1] as JournalAppendEvent);
						return value.apply(target, args);
					}
				: value.bind(target);
		},
	});
}

/** The journal a remote store gives: every append takes one network round trip. */
export function journalWithAppendLatency(journal: MemoryRunJournal, latencyMs: number): MemoryRunJournal {
	return journalInterceptingAppend(journal, () => delay(latencyMs));
}

export function isCompletedStatusAppend(event: JournalAppendEvent): boolean {
	return event.type === "StatusChanged" && event.payload.status === "completed";
}

export const endingWorkflow = workflow({
	name: "quick",
	description: "Ends at once.",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("step", {}, async () => true);
		return {};
	},
});

/** One host session's workflows extension over an explicit journal, driven through the real lifecycle handlers. */
export function workflowHostOverJournal(journal: MemoryRunJournal, definitions = [endingWorkflow]) {
	const store = createStore();
	const runState: WorkflowSessionRunState = {
		store,
		stageControlRegistry: createStageControlRegistry(),
		cancellationRegistry: createCancellationRegistry(),
		toolControlRegistry: createToolControlRegistry(),
		jobs: createJobTracker(),
		stageUiBroker: new StageUiBroker(store),
	};
	const handlers = new Map<string, SessionShutdownHandler>();
	registerWorkflowLifecycleHandlers(
		{
			lifecycleScope: {},
			on: (type: string, handler: SessionShutdownHandler) => {
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
			runState,
		},
	);
	const runtime = createExtensionRuntime({
		definitions,
		journal,
		store,
		jobs: runState.jobs,
		cancellation: runState.cancellationRegistry,
		stageControlRegistry: runState.stageControlRegistry,
		toolControlRegistry: runState.toolControlRegistry,
		stageUiBroker: runState.stageUiBroker,
	});
	return {
		store,
		runState,
		runtime,
		shutdown: () => handlers.get("session_shutdown")!({ reason: "quit" }),
		/** Resolves with the root run id as the run first reports that it ended, as a host's `workflow_lifecycle` hook sees it. */
		reportsEnded(status: "completed" | "failed" = "completed"): Promise<string> {
			return new Promise((resolve) => {
				const observation = workflowObservationRuntime(store);
				const listener = (event: WorkflowRuntimeEvent) => {
					if (event.kind !== "lifecycle") return;
					const { target, rootRunId } = event.event;
					if (target.kind === "run" && target.runId === rootRunId && target.status === status) {
						observation.listeners.delete(listener);
						resolve(rootRunId);
					}
				};
				observation.listeners.add(listener);
			});
		},
	};
}

export async function journalEventTypes(journal: MemoryRunJournal, runId: string): Promise<string[]> {
	const types: string[] = [];
	for await (const entry of journal.read(runId)) types.push(entry.event.type);
	return types;
}

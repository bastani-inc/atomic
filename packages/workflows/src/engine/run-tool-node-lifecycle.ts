import type { DurableWorkflowBackend } from "../durable/backend.js";
import { type CreateToolPrimitiveInput, createToolPrimitive } from "../durable/tool-primitive.js";
import { unknownErrorMessage } from "../runs/foreground/executor-abort.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot, ToolNodeSnapshot } from "../shared/store-types.js";
import type { WorkflowToolPrimitive } from "../shared/types.js";
import type { GraphFrontierTracker } from "./graph-inference.js";
import { durableRunTopology } from "./run-durable-topology.js";
import type { RunTerminalEventArbiter } from "./run-terminal-event.js";
import type { ToolAdmissionBoundary } from "./run-tool-admission-boundary.js";
import type { ToolControlRegistry } from "./run-tool-control-registry.js";
import { type AdmittedToolExecutionTracker, createAdmittedToolExecutionTracker } from "./run-tool-execution-tracker.js";
import { isWorkflowToolAbortError, type WorkflowGracefulQuitSignal } from "./workflow-tool-abort.js";

type ToolNodeLifecycle = Pick<
	CreateToolPrimitiveInput,
	"onNodeStart" | "onNodeRunning" | "onNodeEnd" | "onNodeSettle" | "runTopology"
>;

export function createToolNodeLifecycle(input: {
	readonly store: Store;
	readonly tracker: GraphFrontierTracker;
	readonly run: RunSnapshot;
	readonly sourceToReplayedNodeIds: Map<string, string>;
}): ToolNodeLifecycle {
	const { store, tracker, run, sourceToReplayedNodeIds } = input;
	/**
	 * True while this executor's own run snapshot is the one the store holds.
	 *
	 * A resume relaunches under the *same* run id, so a stale callback abandoned
	 * by quit could otherwise mutate the replacement run's tool node. Object
	 * identity, not the id, decides which generation owns the store row. The
	 * abandoned callback may still settle its own private graph tracker.
	 */
	const ownsCurrentRun = (): boolean => store.runs().some((candidate) => candidate === run);
	return {
		onNodeStart: (node) => {
			const inferredParents = tracker.onSpawn(node.id, node.name);
			const sourceParents =
				node.replayed === true && node.topologyState !== "unavailable" ? node.parentIds : undefined;
			const restored = sourceParents?.map((sourceId) => sourceToReplayedNodeIds.get(sourceId));
			const parentIds = restored?.every((id): id is string => id !== undefined) ? restored : inferredParents;
			tracker.replaceParents(node.id, parentIds);
			(node as ToolNodeSnapshot & { parentIds: readonly string[] }).parentIds = Object.freeze([...parentIds]);
			sourceToReplayedNodeIds.set(node.id, node.id);
			if (ownsCurrentRun()) store.recordToolNodeStart(run.id, node);
		},
		onNodeRunning: (nodeId, startedAt) => {
			if (ownsCurrentRun()) store.recordToolNodeRunning(run.id, nodeId, startedAt);
		},
		onNodeEnd: (nodeId, update) => {
			if (ownsCurrentRun()) store.recordToolNodeEnd(run.id, nodeId, update);
		},
		onNodeSettle: (nodeId) => {
			tracker.onSettle(nodeId);
		},
		runTopology: durableRunTopology(run),
	};
}

/** Wire durable tool execution to terminal-event arbitration and graph state. */
export function createTrackedToolPrimitive(input: {
	readonly workflowId: string;
	readonly backend: DurableWorkflowBackend;
	readonly nextCheckpointId: () => string;
	readonly controller: AbortController;
	readonly terminalEvents: RunTerminalEventArbiter;
	readonly store: Store;
	readonly tracker: GraphFrontierTracker;
	readonly run: RunSnapshot;
	readonly sourceToReplayedNodeIds: Map<string, string>;
	readonly toolControls: ToolControlRegistry;
	readonly toolAdmission: ToolAdmissionBoundary;
}): {
	readonly tool: WorkflowToolPrimitive;
	readonly admittedTools: AdmittedToolExecutionTracker;
	/** Abandon still-unsettled tool executions and publish them as cancelled. */
	readonly abandonInFlightAsCancelled: (reason: unknown) => readonly string[];
	/**
	 * The whole-run quit this executor's own tool work observed, if any: a node
	 * aborted with quit scope, or a call refused after quit closed admission.
	 *
	 * `run()` uses this rather than the boundary's closed state so a quit that
	 * only paused stages (and was later resumed) can still complete normally,
	 * while a caught tool cancellation cannot convert quit into completion.
	 */
	readonly observedQuitCancellation: () => WorkflowGracefulQuitSignal | undefined;
} {
	let observedQuit: WorkflowGracefulQuitSignal | undefined;
	const admittedTools = createAdmittedToolExecutionTracker({
		onFailureObserved: ({ error, nodeId }) => {
			input.terminalEvents.selectFailure(error, nodeId);
		},
		onFailureDuringDrain: (failure) => {
			if (input.terminalEvents.winner()?.kind === "failure") input.controller.abort(failure.error);
		},
	});
	const lifecycle = createToolNodeLifecycle(input);
	const tool = createToolPrimitive({
		workflowId: input.workflowId,
		backend: input.backend,
		onFailureObserved: admittedTools.observeFailure,
		nextCheckpointId: input.nextCheckpointId,
		throwIfCancelled: () => {
			if (input.controller.signal.aborted) throw new Error("atomic-workflows: workflow cancelled");
		},
		signal: input.controller.signal,
		trackExecution: admittedTools.track,
		registerNodeControl: (registration) => {
			registration.controller.signal.addEventListener(
				"abort",
				() => {
					const reason: unknown = registration.controller.signal.reason;
					if (isWorkflowToolAbortError(reason) && reason.scope === "quit") observedQuit ??= reason;
				},
				{ once: true },
			);
			return input.toolControls.register({
				runId: input.run.id,
				nodeId: registration.nodeId,
				name: registration.name,
				controller: registration.controller,
				settled: registration.settled,
			});
		},
		admitToolCall: () => {
			const admission = input.toolAdmission.admit();
			if (!admission.accepted) observedQuit ??= admission.error;
			return admission;
		},
		...lifecycle,
	});
	const abandonInFlightAsCancelled = (reason: unknown): readonly string[] => {
		const endedAt = Date.now();
		const error = unknownErrorMessage(reason);
		const abandoned = admittedTools.abandonNonFailed();
		for (const nodeId of abandoned) {
			lifecycle.onNodeEnd?.(nodeId, { status: "cancelled", endedAt, error });
			lifecycle.onNodeSettle?.(nodeId);
		}
		return abandoned;
	};
	input.controller.signal.addEventListener(
		"abort",
		() => {
			if (input.terminalEvents.winner()?.kind !== "failure") return;
			abandonInFlightAsCancelled(input.controller.signal.reason);
		},
		{ once: true },
	);
	return { tool, admittedTools, abandonInFlightAsCancelled, observedQuitCancellation: () => observedQuit };
}

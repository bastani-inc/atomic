import type { DurableWorkflowBackend } from "../durable/backend.js";
import { type CreateToolPrimitiveInput, createToolPrimitive } from "../durable/tool-primitive.js";
import { unknownErrorMessage } from "../runs/foreground/executor-abort.js";
import { REPLAY_TOPOLOGY_MISMATCH_MESSAGE } from "../shared/replay-topology-failure.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot, ToolNodeSnapshot } from "../shared/store-types.js";
import type { WorkflowToolPrimitive } from "../shared/types.js";
import type { GraphFrontierTracker } from "./graph-inference.js";
import { sameStringSet } from "./replay.js";
import type { RunBudgetController } from "./run-budget.js";
import { durableRunTopology } from "./run-durable-topology.js";
import type { RunTerminalEventArbiter } from "./run-terminal-event.js";
import type { ToolAdmissionBoundary } from "./run-tool-admission-boundary.js";
import type { ToolControlRegistry } from "./run-tool-control-registry.js";
import { type AdmittedToolExecutionTracker, createAdmittedToolExecutionTracker } from "./run-tool-execution-tracker.js";
import { isWorkflowToolAbortError, type WorkflowGracefulQuitSignal } from "./workflow-tool-abort.js";

type ToolNodeLifecycle = Pick<
	CreateToolPrimitiveInput,
	"onNodeStart" | "onNodeRunning" | "onNodeEnd" | "onNodeSettle" | "runTopology"
> & { readonly assertFrontierConsumed: () => void };

export function createToolNodeLifecycle(input: {
	readonly store: Store;
	readonly tracker: GraphFrontierTracker;
	readonly run: RunSnapshot;
	readonly sourceToContinuationNodeIds: Map<string, string>;
	readonly resumeToolNode?: ToolNodeSnapshot;
}): ToolNodeLifecycle {
	const { store, tracker, run, sourceToContinuationNodeIds } = input;
	/**
	 * True while this executor's own run snapshot is the one the store holds.
	 *
	 * A resume relaunches under the *same* run id, so a stale callback abandoned
	 * by quit could otherwise mutate the replacement run's tool node. Object
	 * identity, not the id, decides which generation owns the store row. The
	 * abandoned callback may still settle its own private graph tracker.
	 */
	const ownsCurrentRun = (): boolean => store.runs().some((candidate) => candidate === run);
	const replayedToolNodeIds = new Set<string>();
	let pendingFrontier = input.resumeToolNode;
	return {
		assertFrontierConsumed: () => {
			if (pendingFrontier !== undefined) {
				throw new Error(
					`${REPLAY_TOPOLOGY_MISMATCH_MESSAGE} for unfinished tool ${pendingFrontier.id}: pending frontier was not consumed`,
				);
			}
		},
		onNodeStart: (node) => {
			const frontier = node.replayed === true ? undefined : pendingFrontier;
			if (
				frontier !== undefined &&
				(node.id !== frontier.id || node.argsHash !== frontier.argsHash || node.ordinal !== frontier.ordinal)
			) {
				throw new Error(`${REPLAY_TOPOLOGY_MISMATCH_MESSAGE} for unfinished tool ${frontier.id}`);
			}
			const inferredParents = tracker.onSpawn(node.id, node.name);
			const sourceParents =
				frontier?.parentIds ??
				(node.replayed === true && node.topologyState !== "unavailable" ? node.parentIds : undefined);
			const restored = sourceParents?.map((sourceId) => sourceToContinuationNodeIds.get(sourceId));
			const translated = restored?.every((id): id is string => id !== undefined) ? restored : undefined;
			if (run.resumedFromRunId !== undefined && sourceParents !== undefined && translated === undefined) {
				throw new Error(
					`${REPLAY_TOPOLOGY_MISMATCH_MESSAGE} for tool "${node.name}" (node "${node.id}") in source run ${run.resumedFromRunId}`,
				);
			}
			if (
				translated !== undefined &&
				run.resumedFromRunId !== undefined &&
				!compatibleReplayedToolParents(tracker, translated, inferredParents, (parentId) =>
					isReplayedContinuationNode(store, run, replayedToolNodeIds, parentId),
				)
			) {
				throw new Error(
					`${REPLAY_TOPOLOGY_MISMATCH_MESSAGE} for tool "${node.name}" (node "${node.id}") in source run ${run.resumedFromRunId}`,
				);
			}
			const parentIds = translated ?? inferredParents;
			tracker.replaceParents(node.id, parentIds);
			(node as ToolNodeSnapshot & { parentIds: readonly string[] }).parentIds = Object.freeze([...parentIds]);
			sourceToContinuationNodeIds.set(node.id, node.id);
			if (node.replayed === true) replayedToolNodeIds.add(node.id);
			if (ownsCurrentRun()) store.recordToolNodeStart(run.id, node);
			if (frontier !== undefined) pendingFrontier = undefined;
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

/**
 * Fresh-ID replay must not keep stale source parents when the continuation
 * admitted a different graph. Cache-hit siblings can settle before the next
 * sibling spawns, so inferred parents may be replayed tools or stages rather
 * than the restored set. An inserted live node is not a replayed sibling.
 */
function isReplayedContinuationNode(
	store: Store,
	run: RunSnapshot,
	replayedToolNodeIds: ReadonlySet<string>,
	nodeId: string,
): boolean {
	if (replayedToolNodeIds.has(nodeId)) return true;
	const live = store.runs().find((candidate) => candidate === run);
	return live?.stages.some((stage) => stage.id === nodeId && stage.replayed === true) === true;
}

function compatibleReplayedToolParents(
	tracker: GraphFrontierTracker,
	translated: readonly string[],
	inferredParents: readonly string[],
	isReplayedNode: (nodeId: string) => boolean,
): boolean {
	if (sameStringSet(translated, inferredParents)) return true;
	if (inferredParents.length === 0) return false;
	return inferredParents.every(
		(parentId) => isReplayedNode(parentId) && sameStringSet(tracker.getParents(parentId), translated),
	);
}

/** Wire durable tool execution to terminal-event arbitration and graph state. */
export function createTrackedToolPrimitive(input: {
	readonly workflowId: string;
	readonly checkpointSourceWorkflowId?: string;
	readonly backend: DurableWorkflowBackend;
	readonly nextCheckpointId: () => string;
	readonly controller: AbortController;
	readonly terminalEvents: RunTerminalEventArbiter;
	readonly store: Store;
	readonly tracker: GraphFrontierTracker;
	readonly run: RunSnapshot;
	readonly sourceToContinuationNodeIds: Map<string, string>;
	readonly resumeToolNode?: ToolNodeSnapshot;
	readonly toolControls: ToolControlRegistry;
	readonly toolAdmission: ToolAdmissionBoundary;
	readonly budget: RunBudgetController;
}): {
	readonly tool: WorkflowToolPrimitive;
	readonly admittedTools: AdmittedToolExecutionTracker;
	readonly assertFrontierConsumed: () => void;
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
		signal: input.controller.signal,
		onFailureObserved: ({ error, nodeId }) => {
			input.terminalEvents.selectFailure(error, nodeId);
		},
		onFailureDuringDrain: (failure) => {
			if (input.terminalEvents.winner()?.kind === "failure") input.controller.abort(failure.error);
		},
	});
	const lifecycle = createToolNodeLifecycle(input);
	const budgetBoundary = input.budget.enabled
		? (): Promise<void> => input.budget.stopAtBoundaryAsync(input.run.stages.at(-1)?.name)
		: undefined;
	const tool = createToolPrimitive({
		workflowId: input.workflowId,
		...(input.checkpointSourceWorkflowId === undefined
			? {}
			: { checkpointSourceWorkflowId: input.checkpointSourceWorkflowId }),
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
		...(budgetBoundary !== undefined ? { beforeToolCall: budgetBoundary, afterToolCall: budgetBoundary } : {}),
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
	return {
		tool,
		admittedTools,
		assertFrontierConsumed: lifecycle.assertFrontierConsumed,
		abandonInFlightAsCancelled,
		observedQuitCancellation: () => observedQuit,
	};
}

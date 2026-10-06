export type WorkflowActivityState = "working" | "idle" | "blocked";
export type WorkflowActivityReason =
	| "executing"
	| "automatic_continuation"
	| "retrying"
	| "stopping"
	| "awaiting_input"
	| "manual_intervention"
	| "paused"
	| "quiescent";

// Kept in sync with workflows/shared/store-types without a host runtime dependency.
export type WorkflowRunStatus =
	| "pending"
	| "running"
	| "paused"
	| "completed"
	| "skipped"
	| "cancelled"
	| "blocked"
	| "failed"
	| "killed";
export type WorkflowStageStatus =
	| "pending"
	| "running"
	| "awaiting_input"
	| "paused"
	| "blocked"
	| "completed"
	| "failed"
	| "skipped";
export type WorkflowToolNodeStatus = "pending" | "running" | "completed" | "failed" | "cached" | "cancelled";
export type WorkflowControlAction = "quit" | "kill" | "pause" | "resume";

/** Snapshot-safe descriptor of a human-input prompt waiting on a workflow graph node. */
export interface WorkflowGraphNodePrompt {
	id: string;
	kind: "input" | "confirm" | "select" | "editor" | "custom";
	message: string;
	choices?: readonly string[];
	createdAt: number;
}
interface WorkflowGraphNodeBase {
	/** Graph-unique node id: run-local in the root run, `${runId}:${nodeId}` inside nested child runs. */
	id: string;
	/** Run that owns the node. */
	runId: string;
	/** Run-local stage id or tool node id. */
	nodeId: string;
	name: string;
	/** Graph-unique ids of the node's parents. */
	parentIds: readonly string[];
	/** Admission order shared by stages and tool nodes within one run. */
	executionOrder?: number;
	/** Nested workflow depth; 0 for the root run. */
	depth: number;
}
export interface WorkflowGraphStageNode extends WorkflowGraphNodeBase {
	kind: "stage";
	status: WorkflowStageStatus;
	pendingPrompt?: WorkflowGraphNodePrompt;
}
export interface WorkflowGraphToolNode extends WorkflowGraphNodeBase {
	kind: "tool";
	status: WorkflowToolNodeStatus;
	/** Invocation ordinal of this `ctx.tool` call within its run. */
	ordinal: number;
}
export type WorkflowGraphNode = WorkflowGraphStageNode | WorkflowGraphToolNode;
/** A human-input prompt raised by a run itself rather than by one of its stages. */
export interface WorkflowGraphRunPrompt extends WorkflowGraphNodePrompt {
	/** Run that owns the prompt. */
	runId: string;
}
/** Expanded graph of one root run, including nested child workflow runs. */
export interface WorkflowRootGraph {
	nodes: readonly WorkflowGraphNode[];
	/** Run-level prompts awaiting an answer; absent when there are none. */
	runPrompts?: readonly WorkflowGraphRunPrompt[];
}

export interface WorkflowRootActivity {
	rootRunId: string;
	ownerSessionId: string;
	state: WorkflowActivityState;
	reason: WorkflowActivityReason;
	activeExecutionCount: number;
	actionableBlockCount: number;
	needsAttention: boolean;
	/** Graph topology and node statuses; absent when the publisher reports no graph. */
	graph?: WorkflowRootGraph;
}
export interface WorkflowObservationCursor {
	epoch: string;
	revision: number;
}
export type WorkflowActivitySnapshotInput =
	| { availability: "ready"; roots: readonly WorkflowRootActivity[] }
	| { availability: "recovering" | "unavailable" };
export type WorkflowActivitySnapshotFrame = WorkflowActivitySnapshotInput & {
	kind: "snapshot";
	cursor: WorkflowObservationCursor;
};
export type WorkflowActivityFrame =
	| WorkflowActivitySnapshotFrame
	| { kind: "changed"; cursor: WorkflowObservationCursor; root: WorkflowRootActivity }
	| { kind: "removed"; cursor: WorkflowObservationCursor; rootRunId: string };
export type WorkflowActivityObserver = (frame: WorkflowActivityFrame) => void | Promise<void>;
export interface WorkflowActivitySubscription {
	dispose(): void;
}
export type WorkflowLifecycleDelivery = "live" | "replay";
export type WorkflowLifecycleTarget =
	| {
			kind: "run";
			runId: string;
			previousStatus?: WorkflowRunStatus;
			status: WorkflowRunStatus;
			action?: WorkflowControlAction;
	  }
	| {
			kind: "stage";
			runId: string;
			stageId: string;
			stageName: string;
			previousStatus?: WorkflowStageStatus;
			status: WorkflowStageStatus;
	  }
	| {
			kind: "tool";
			runId: string;
			toolNodeId: string;
			toolName: string;
			previousStatus?: WorkflowToolNodeStatus;
			status: WorkflowToolNodeStatus;
	  }
	| { kind: "prompt"; runId: string; stageId?: string; promptId: string; status: "opened" | "answered" | "cancelled" };
export interface WorkflowLifecycleEvent {
	type: "workflow_lifecycle";
	eventId: string;
	cursor: WorkflowObservationCursor;
	runId: string;
	rootRunId: string;
	ownerSessionId: string;
	occurredAt: number;
	observedAt: number;
	delivery: WorkflowLifecycleDelivery;
	target: WorkflowLifecycleTarget;
	attribution?: "user" | "agent" | "scheduler" | "recovery" | "unknown";
}
export interface WorkflowStageCompletedEvent extends Omit<WorkflowLifecycleEvent, "type" | "target"> {
	type: "workflow_stage_completed";
	target: Extract<WorkflowLifecycleTarget, { kind: "stage" }> & { status: "completed" };
}
export interface WorkflowActivityChangedEvent {
	type: "workflow_activity_changed";
	cursor: WorkflowObservationCursor;
	root: WorkflowRootActivity;
}
export interface WorkflowHeartbeatEvent {
	type: "workflow_heartbeat";
	runId: string;
	rootRunId: string;
	ownerSessionId: string;
	scheduledAt: number;
	intervalMinutes: number;
}
export type WorkflowEvent =
	| WorkflowLifecycleEvent
	| WorkflowStageCompletedEvent
	| WorkflowActivityChangedEvent
	| WorkflowHeartbeatEvent;
export interface WorkflowActivityPublisher {
	publishSnapshot(input: WorkflowActivitySnapshotInput): void;
	publishChanged(root: WorkflowRootActivity): void;
	publishRemoved(rootRunId: string): void;
	publishLifecycle(event: Omit<WorkflowLifecycleEvent, "cursor">): void;
	publishHeartbeat(event: WorkflowHeartbeatEvent): void;
	dispose(): void;
}
export interface WorkflowObservationDiagnostic {
	kind:
		| "ObserverDisposed"
		| "SourceRecovering"
		| "SourceUnavailable"
		| "ObserverDeliveryFailed"
		| "ObserverOverflow"
		| "PublisherFenced";
	cursor: WorkflowObservationCursor;
}

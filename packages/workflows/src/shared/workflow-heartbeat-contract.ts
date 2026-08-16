/** Cadence used when a workflow definition omits `heartbeatIntervalMinutes`. */
export const DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES = 15;

export const WORKFLOW_HEARTBEAT_CUSTOM_TYPE = "workflows:workflow-heartbeat";

/** Stable identity for one scheduled boundary of a workflow run. */
export interface WorkflowHeartbeatIdentity {
	readonly runId: string;
	/** Unix timestamp in milliseconds for the cadence boundary. */
	readonly scheduledAt: number;
}

/** Deterministic context carried by a workflow heartbeat event. */
export interface WorkflowHeartbeatEventDetails extends WorkflowHeartbeatIdentity {
	readonly workflowName: string;
	/** Persisted workflow start timestamp in Unix milliseconds. */
	readonly startedAt: number;
	readonly intervalMinutes: number;
}

/** Slice-1 event envelope; scheduling and delivery are wired separately. */
export interface WorkflowHeartbeatEvent {
	readonly customType: typeof WORKFLOW_HEARTBEAT_CUSTOM_TYPE;
	readonly details: WorkflowHeartbeatEventDetails;
}

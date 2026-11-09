import type { RunSnapshot, StageStatus } from "./store-types.js";

/**
 * What a stage released from memory was called before `suspended` replaced it (#4589). Records and snapshots written
 * then still hold it, and callers may still send it as a status filter.
 */
export type LegacyWaitingStatus = "waiting";

/** A stage status as stored: a record written before the rename holds `waiting`. */
export type RecordedStageStatus = StageStatus | LegacyWaitingStatus;

function isLegacyWaiting(status: RecordedStageStatus): boolean {
	return status === "waiting";
}

/** The current status of a stored stage status. */
export function stageStatusFromRecord(status: RecordedStageStatus): StageStatus {
	return status === "waiting" ? "suspended" : status;
}

/** `runs` with every stage a legacy record calls `waiting` shown as `suspended`; runs with none are returned as they are. */
export function runSnapshotsFromRecord(runs: readonly RunSnapshot[]): readonly RunSnapshot[] {
	return runs.map((run) =>
		run.stages.some((stage) => isLegacyWaiting(stage.status))
			? { ...run, stages: run.stages.map((stage) => ({ ...stage, status: stageStatusFromRecord(stage.status) })) }
			: run,
	);
}

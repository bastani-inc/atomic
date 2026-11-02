import type { RunSnapshot } from "./store-types.js";

/** Live execution observations. */
export interface RunExecutionState {
	phase?: "starting" | "executing" | "ended";
	phaseStartedAt?: number;
	dependencyError?: string;
	lastProgressAt?: number;
	controlPersistence?: "observed" | "durable";
	controlRequestedStatus?: "paused" | "running";
	/** Why queued Intercom messages did not reach some stages on local workers; one summary for the run. */
	intercomDeliveryIssue?: string;
}

export interface RunExecutionObservation extends RunExecutionState {
	phaseAgeMs?: number;
}

export function observeRunExecution(run: RunSnapshot, now = Date.now()): RunExecutionObservation {
	let lastProgressAt = run.lastProgressAt ?? run.startedAt;
	for (const node of [...run.stages, ...run.toolNodes]) {
		lastProgressAt = Math.max(lastProgressAt, node.startedAt ?? 0, node.endedAt ?? 0);
	}
	return {
		phase: run.phase,
		phaseStartedAt: run.phaseStartedAt,
		phaseAgeMs: run.phaseStartedAt === undefined ? undefined : Math.max(0, now - run.phaseStartedAt),
		dependencyError: run.dependencyError,
		lastProgressAt,
		controlPersistence: run.controlPersistence,
		controlRequestedStatus: run.controlRequestedStatus,
		...(run.intercomDeliveryIssue === undefined ? {} : { intercomDeliveryIssue: run.intercomDeliveryIssue }),
	};
}

import type { WorkflowChildResult, WorkflowOutputValues } from "../shared/types.js";
import { sameRun, sameStrings } from "./stage-topology-validation.js";
import {
	DURABLE_BOUNDARY_TOPOLOGY_VERSION,
	DURABLE_STAGE_TOPOLOGY_VERSION,
	type DurableStageCheckpoint,
	type DurableStageRunTopology,
	type DurableStageTopology,
	type DurableWorkflowBoundaryTopology,
} from "./types.js";
import { parseWorkflowChildResult } from "./workflow-child-result.js";

export interface ValidBoundaryLifecycle {
	readonly latestTerminal?: DurableStageCheckpoint;
	readonly completedOutput?: WorkflowChildResult<WorkflowOutputValues>;
}

export type BoundaryLifecycleResolution = { readonly error: string } | { readonly lifecycle: ValidBoundaryLifecycle };

/** Validate one boundary's atomic start/terminal lifecycle and resolve its latest legal state. */
export function resolveBoundaryLifecycle(
	start: DurableStageCheckpoint,
	stages: readonly DurableStageCheckpoint[],
	requireTerminal: boolean,
): BoundaryLifecycleResolution {
	const startTopology = start.topology;
	const startBoundary = startTopology?.boundary;
	const startRun = startTopology?.run;
	const related = stages.filter((stage) => {
		const boundary = stage.topology?.boundary;
		return (
			boundary !== undefined &&
			(stage.replayKey === start.replayKey ||
				stage.topology?.stageId === startTopology?.stageId ||
				boundary.child.runId === startBoundary?.child.runId)
		);
	});
	const starts = related.filter((stage) => stage.topology!.boundary!.event === "start");
	if (starts.length !== 1 || starts[0] !== start) return failure("boundary has no unique start record");
	if (
		startTopology === undefined ||
		startBoundary === undefined ||
		startRun === undefined ||
		startTopology.version !== DURABLE_STAGE_TOPOLOGY_VERSION ||
		startBoundary.version !== DURABLE_BOUNDARY_TOPOLOGY_VERSION ||
		startTopology.stageId.length === 0 ||
		startTopology.sourceOrder === undefined ||
		startTopology.status !== "running" ||
		startBoundary.status !== "running" ||
		startBoundary.event !== "start" ||
		start.output !== undefined ||
		startBoundary.replayScope !== start.replayKey ||
		!validBoundaryOwnership(startTopology, startRun, startBoundary)
	) {
		return failure("malformed boundary-start transition");
	}

	const terminals = related.filter((stage) => stage.topology!.boundary!.event === "terminal");
	if (terminals.length === 0) {
		return requireTerminal ? failure("completed boundary has no terminal record") : { lifecycle: {} };
	}
	const statuses = new Set<string>();
	let completedOutput: WorkflowChildResult<WorkflowOutputValues> | undefined;
	for (const terminal of terminals) {
		const terminalTopology = terminal.topology!;
		const terminalBoundary = terminalTopology.boundary!;
		if (statuses.has(terminalBoundary.status) || terminalTopology.status !== terminalBoundary.status) {
			return failure("boundary has conflicting terminal records");
		}
		statuses.add(terminalBoundary.status);
		if (
			terminalTopology.version !== startTopology.version ||
			terminalTopology.stageId !== startTopology.stageId ||
			!sameStrings(terminalTopology.parentIds, startTopology.parentIds) ||
			terminalTopology.sourceOrder !== startTopology.sourceOrder ||
			!sameRun(terminalTopology.run, startRun) ||
			terminal.name !== start.name ||
			terminal.replayKey !== start.replayKey ||
			terminalBoundary.version !== startBoundary.version ||
			terminalBoundary.replayScope !== startBoundary.replayScope ||
			terminalBoundary.alias !== startBoundary.alias ||
			terminalBoundary.workflow !== startBoundary.workflow ||
			terminalBoundary.invocationFingerprint !== startBoundary.invocationFingerprint ||
			!sameBoundaryChild(terminalBoundary.child, startBoundary.child)
		) {
			return failure("boundary terminal immutable identity drifted from its start");
		}
		if (terminalBoundary.status === "completed") {
			const parsed = parseWorkflowChildResult(terminal.output);
			if (
				parsed === undefined ||
				parsed.runId !== startBoundary.child.runId ||
				parsed.workflow !== startBoundary.workflow
			) {
				return failure("completed boundary output is malformed or stale");
			}
			completedOutput = parsed;
		} else if (terminal.output !== undefined) {
			return failure("failed or skipped boundary cannot persist a successful output");
		}
	}

	if (
		terminals.length > 2 ||
		(terminals.length === 2 &&
			(!statuses.has("completed") ||
				(!statuses.has("failed") && !statuses.has("skipped")) ||
				terminals[0]!.completedAt === terminals[1]!.completedAt))
	) {
		return failure("boundary has an illegal terminal transition");
	}
	const completed = terminals.find((terminal) => terminal.topology!.boundary!.status === "completed");
	const outputRecords = stages.filter((stage) => stage.replayKey === start.replayKey && stage.output !== undefined);
	if (
		outputRecords.length !== (completed === undefined ? 0 : 1) ||
		(completed !== undefined && outputRecords[0]?.checkpointId !== completed.checkpointId)
	) {
		return failure("boundary replay key has conflicting output records");
	}
	const latestTerminal = terminals.reduce((latest, terminal) =>
		terminal.completedAt > latest.completedAt ? terminal : latest,
	);
	return {
		lifecycle: {
			latestTerminal,
			...(completedOutput !== undefined ? { completedOutput } : {}),
		},
	};
}

export function boundaryTransitionError(
	start: DurableStageCheckpoint,
	stages: readonly DurableStageCheckpoint[],
	requireTerminal: boolean,
): string | undefined {
	const resolved = resolveBoundaryLifecycle(start, stages, requireTerminal);
	return "error" in resolved ? resolved.error : undefined;
}

function validBoundaryOwnership(
	topology: DurableStageTopology,
	run: DurableStageRunTopology,
	boundary: DurableWorkflowBoundaryTopology,
): boolean {
	const expectedRoot = run.rootRunId ?? run.runId;
	return (
		boundary.alias.length > 0 &&
		boundary.workflow.length > 0 &&
		boundary.child.runId.length > 0 &&
		boundary.child.runName.length > 0 &&
		boundary.child.parentRunId === run.runId &&
		boundary.child.parentStageId === topology.stageId &&
		boundary.child.rootRunId === expectedRoot
	);
}

function sameBoundaryChild(
	actual: DurableWorkflowBoundaryTopology["child"],
	expected: DurableWorkflowBoundaryTopology["child"],
): boolean {
	return (
		actual.runId === expected.runId &&
		actual.runName === expected.runName &&
		actual.parentRunId === expected.parentRunId &&
		actual.parentStageId === expected.parentStageId &&
		actual.rootRunId === expected.rootRunId
	);
}

function failure(error: string): { readonly error: string } {
	return { error };
}

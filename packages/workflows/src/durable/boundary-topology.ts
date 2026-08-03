import type { WorkflowChildResult, WorkflowOutputValues, WorkflowSerializableValue } from "../shared/types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { boundaryTransitionError, resolveBoundaryLifecycle } from "./boundary-lifecycle.js";
import type { DurableScope } from "./scoped-backend.js";
import {
	DURABLE_BOUNDARY_TOPOLOGY_VERSION,
	DURABLE_STAGE_TOPOLOGY_VERSION,
	type DurableCheckpoint,
	type DurableStageCheckpoint,
	type DurableStageLifecycleStatus,
	type DurableStageRunTopology,
	type DurableStageTopology,
	type DurableWorkflowBoundaryTopology,
} from "./types.js";
import { parseWorkflowChildResult } from "./workflow-child-result.js";

export { boundaryTransitionError } from "./boundary-lifecycle.js";

import { directChildTopologyError, owningBoundaryIdError, sameRun, sameStrings } from "./stage-topology-validation.js";

export class DurableNestedTopologyError extends Error {
	constructor(message: string) {
		super(`atomic-workflows: durable nested topology is non-resumable: ${message}`);
		this.name = "DurableNestedTopologyError";
	}
}

export interface DurableBoundaryRuntimeIdentity {
	readonly boundaryId: string;
	readonly childRunId: string;
	readonly parentIds?: readonly string[];
	readonly sourceOrder?: number;
}

export interface DurableChildInvocation {
	readonly scope: DurableScope;
	readonly identity: DurableBoundaryRuntimeIdentity;
	/** Align a new boundary with an ordinary continuation result before recording its start. */
	adoptReplayedChildRunId(runId: string): void;
	recordStart(parentIds: readonly string[], sourceOrder: number): Promise<void>;
	recordTerminal(
		status: Extract<DurableStageLifecycleStatus, "completed" | "failed" | "skipped">,
		output?: WorkflowChildResult<WorkflowOutputValues>,
	): Promise<void>;
}

export interface DurableBoundaryDescriptor {
	readonly workflowId: string;
	readonly rootWorkflowId: string;
	readonly backend: DurableWorkflowBackend;
	readonly replayKey: string;
	readonly boundaryName: string;
	readonly alias: string;
	readonly workflow: string;
	readonly childRunName: string;
	readonly invocationFingerprint: string;
	readonly runTopology: DurableStageRunTopology;
}

export function validateDurableChildInvocation(input: DurableBoundaryDescriptor): void {
	validatedInvocationRecords(input);
}

export function prepareDurableChildInvocation(input: DurableBoundaryDescriptor): DurableChildInvocation {
	const { stages, start } = validatedInvocationRecords(input);
	if (start !== undefined) {
		const resolved = resolveBoundaryLifecycle(start, stages, false);
		if ("error" in resolved) throw invalid(input, resolved.error);
		const terminalStatus = resolved.lifecycle.latestTerminal?.topology?.boundary?.status;
		if (terminalStatus !== undefined && terminalStatus !== "failed") {
			throw invalid(input, "terminal boundary has no valid replayable child result");
		}
	}
	let childRunId = start?.topology?.boundary?.child.runId ?? crypto.randomUUID();
	const boundaryId = start?.topology?.stageId ?? crypto.randomUUID();
	const startedAt = start?.startedAt ?? Date.now();
	let topology = start?.topology;
	let terminalRecorded = false;
	const identity: DurableBoundaryRuntimeIdentity = {
		boundaryId,
		get childRunId() {
			return childRunId;
		},
		...(topology !== undefined
			? {
					parentIds: [...topology.parentIds],
					sourceOrder: topology.sourceOrder,
				}
			: {}),
	};

	return {
		scope: { rootWorkflowId: input.rootWorkflowId, scopePrefix: input.replayKey },
		identity,
		adoptReplayedChildRunId(runId): void {
			if (topology !== undefined && childRunId !== runId) {
				throw invalid(input, "continuation child identity disagrees with durable boundary ownership");
			}
			childRunId = runId;
		},
		async recordStart(parentIds, sourceOrder): Promise<void> {
			if (topology !== undefined) {
				if (topology.sourceOrder !== sourceOrder || !sameStrings(topology.parentIds, parentIds)) {
					throw invalid(input, "persisted source order or parent edges do not match replay");
				}
				return;
			}
			topology = makeTopology(input, boundaryId, childRunId, parentIds, sourceOrder, "start", "running");
			await input.backend.recordCheckpointAsync({
				kind: "stage",
				workflowId: input.workflowId,
				checkpointId: `boundary-start:${input.replayKey}`,
				name: input.boundaryName,
				replayKey: input.replayKey,
				topology,
				startedAt,
				completedAt: startedAt,
			});
		},
		async recordTerminal(status, output): Promise<void> {
			if (terminalRecorded) return;
			if (topology === undefined) throw invalid(input, "boundary terminal state preceded its durable start");
			const parsedOutput =
				output === undefined ? undefined : parseWorkflowChildResult(output as WorkflowSerializableValue);
			if (
				status === "completed" &&
				(parsedOutput === undefined ||
					parsedOutput.runId !== childRunId ||
					parsedOutput.workflow !== input.workflow)
			) {
				throw invalid(input, "completed boundary output disagrees with durable child identity");
			}
			if (status !== "completed" && output !== undefined) {
				throw invalid(input, "failed or skipped boundary cannot persist a successful output");
			}
			terminalRecorded = true;
			const terminalTopology = makeTopology(
				input,
				boundaryId,
				childRunId,
				topology.parentIds,
				topology.sourceOrder!,
				"terminal",
				status,
			);
			const priorTerminalAt = stages
				.filter((stage) => stage.replayKey === input.replayKey && stage.topology?.boundary?.event === "terminal")
				.reduce((latest, stage) => Math.max(latest, stage.completedAt), 0);
			const now = Math.max(Date.now(), priorTerminalAt + 1);
			await input.backend.recordCheckpointAsync({
				kind: "stage",
				workflowId: input.workflowId,
				checkpointId: `boundary-terminal:${input.replayKey}:${status}`,
				name: input.boundaryName,
				replayKey: input.replayKey,
				topology: terminalTopology,
				...(output !== undefined ? { output: output as WorkflowSerializableValue, result: output.status } : {}),
				startedAt,
				endedAt: now,
				completedAt: now,
			});
		},
	};
}

export function validateDurableCompletedBoundary(
	input: DurableBoundaryDescriptor & {
		readonly checkpoint: DurableStageCheckpoint & { readonly output: WorkflowSerializableValue };
		readonly output: WorkflowChildResult<WorkflowOutputValues>;
	},
): void {
	const { checkpoint, output } = input;
	if (output.workflow !== input.workflow)
		throw invalid(input, "completed boundary workflow does not match the call site");
	const checkpoints = input.backend.listCheckpoints(input.workflowId);
	validateScopedIdentities(input, checkpoints);
	const allStages = stageCheckpoints(checkpoints);
	const boundary = checkpoint.topology?.boundary;
	if (boundary !== undefined) {
		const starts = allStages.filter(
			(candidate) => candidate.replayKey === input.replayKey && candidate.topology?.boundary?.event === "start",
		);
		if (starts.length !== 1) throw invalid(input, "completed boundary has no unique reciprocal start record");
		validateStartRecord(input, starts[0]!, allStages, checkpoints);
		const resolved = resolveBoundaryLifecycle(starts[0]!, allStages, true);
		if ("error" in resolved) throw invalid(input, resolved.error);
		if (
			resolved.lifecycle.latestTerminal?.checkpointId !== checkpoint.checkpointId ||
			boundary.event !== "terminal" ||
			boundary.status !== "completed" ||
			boundary.child.runId !== output.runId ||
			boundary.child.parentStageId !== checkpoint.topology?.stageId
		) {
			throw invalid(input, "completed boundary terminal identity is inconsistent");
		}
		return;
	}

	// Current-format compatibility: a completed boundary written before the
	// additive start record is safe only when child checkpoints prove ownership.
	const topology = checkpoint.topology;
	if (topology?.run?.runId !== input.workflowId || topology.stageId.length === 0) {
		throw invalid(input, "completed fallback lacks owning-run topology");
	}
	const expectedChildRun: DurableStageRunTopology = {
		runId: output.runId,
		runName: input.childRunName,
		parentRunId: input.workflowId,
		parentStageId: topology.stageId,
		rootRunId: input.rootWorkflowId,
	};
	const topologyError = directChildTopologyError(
		allStages,
		input.replayKey,
		expectedChildRun,
		false,
		toolNodeIds(checkpoints, expectedChildRun.runId),
	);
	if (topologyError !== undefined) throw invalid(input, topologyError);
	const ownership = reciprocalChildOwnership(
		childStageRecords(allStages, input.replayKey),
		output.runId,
		input.workflowId,
		topology.stageId,
		input.rootWorkflowId,
	);
	if (!ownership.valid || ownership.directGroups === 0) {
		throw invalid(input, "completed fallback lacks reciprocal child ownership");
	}
}

function validateStartRecord(
	input: DurableBoundaryDescriptor,
	start: DurableStageCheckpoint,
	stages: readonly DurableStageCheckpoint[],
	checkpoints: readonly DurableCheckpoint[],
): void {
	const topology = start.topology;
	const boundary = topology?.boundary;
	if (
		topology === undefined ||
		boundary === undefined ||
		topology.sourceOrder === undefined ||
		topology.version !== DURABLE_STAGE_TOPOLOGY_VERSION ||
		topology.status !== "running" ||
		boundary.status !== "running" ||
		start.name !== input.boundaryName ||
		boundary.version !== DURABLE_BOUNDARY_TOPOLOGY_VERSION ||
		boundary.replayScope !== input.replayKey ||
		boundary.alias !== input.alias ||
		boundary.workflow !== input.workflow ||
		boundary.child.runName !== input.childRunName ||
		boundary.child.parentRunId !== input.workflowId ||
		boundary.child.parentStageId !== topology.stageId ||
		boundary.child.rootRunId !== input.rootWorkflowId ||
		!sameRun(topology.run, input.runTopology)
	)
		throw invalid(input, "malformed or stale boundary-start ownership");
	const transitionError = boundaryTransitionError(start, stages, false);
	if (transitionError !== undefined) throw invalid(input, transitionError);
	if (boundary.invocationFingerprint === undefined) {
		const completedLegacy =
			stages.some(
				(stage) =>
					stage.replayKey === input.replayKey &&
					stage.topology?.boundary?.event === "terminal" &&
					stage.topology.boundary.status === "completed",
			) && boundaryTransitionError(start, stages, true) === undefined;
		if (!completedLegacy) {
			throw invalid(input, "active older boundary lacks a provable invocation identity");
		}
	} else if (boundary.invocationFingerprint !== input.invocationFingerprint) {
		throw invalid(input, "boundary invocation fingerprint does not match the validated call inputs");
	}
	const ownerError = owningBoundaryIdError(stages, input.workflowId);
	if (ownerError !== undefined) throw invalid(input, ownerError);
	if (topology.parentIds.includes(topology.stageId)) throw invalid(input, "boundary parent cycle");
	const ownerNodeIds = new Set([
		...stages
			.filter((candidate) => candidate.topology?.run?.runId === input.workflowId)
			.map((candidate) => candidate.topology!.stageId),
		...toolNodeIds(checkpoints, input.workflowId),
	]);
	if (topology.parentIds.some((parentId) => !ownerNodeIds.has(parentId))) {
		throw invalid(input, "boundary references an unknown source parent");
	}
	const expectedChildRun: DurableStageRunTopology = {
		runId: boundary.child.runId,
		runName: boundary.child.runName,
		parentRunId: boundary.child.parentRunId,
		parentStageId: boundary.child.parentStageId,
		rootRunId: boundary.child.rootRunId,
	};
	const childError = directChildTopologyError(
		stages,
		input.replayKey,
		expectedChildRun,
		true,
		toolNodeIds(checkpoints, expectedChildRun.runId),
	);
	if (childError !== undefined) throw invalid(input, childError);
	const ownership = reciprocalChildOwnership(
		childStageRecords(stages, input.replayKey),
		boundary.child.runId,
		input.workflowId,
		topology.stageId,
		input.rootWorkflowId,
	);
	if (!ownership.valid) throw invalid(input, "child checkpoint ownership is not reciprocal");
	const duplicateOwner = stages.some(
		(candidate) =>
			candidate !== start &&
			candidate.topology?.boundary?.event === "start" &&
			candidate.topology.boundary.child.runId === boundary.child.runId &&
			candidate.topology.stageId !== topology.stageId,
	);
	if (duplicateOwner) throw invalid(input, "child run is owned by multiple boundaries");
}

function reciprocalChildOwnership(
	stages: readonly DurableStageCheckpoint[],
	childRunId: string,
	parentRunId: string,
	parentStageId: string,
	rootRunId: string,
): { readonly valid: boolean; readonly directGroups: number } {
	const byReplayKey = new Map<string, DurableStageCheckpoint[]>();
	for (const stage of stages) {
		const group = byReplayKey.get(stage.replayKey) ?? [];
		group.push(stage);
		byReplayKey.set(stage.replayKey, group);
	}
	let directGroups = 0;
	for (const group of byReplayKey.values()) {
		const runAware = group.filter((stage) => stage.topology?.run !== undefined);
		const claimsBoundary = runAware.some((stage) => {
			const run = stage.topology!.run!;
			return run.runId === childRunId || run.parentRunId === parentRunId || run.parentStageId === parentStageId;
		});
		if (!claimsBoundary) continue;
		directGroups += 1;
		if (
			runAware.length === 0 ||
			runAware.some((stage) => {
				const run = stage.topology!.run!;
				return (
					run.runId !== childRunId ||
					run.parentRunId !== parentRunId ||
					run.parentStageId !== parentStageId ||
					run.rootRunId !== rootRunId
				);
			})
		)
			return { valid: false, directGroups };
	}
	return { valid: true, directGroups };
}

function makeTopology(
	input: DurableBoundaryDescriptor,
	boundaryId: string,
	childRunId: string,
	parentIds: readonly string[],
	sourceOrder: number,
	event: DurableWorkflowBoundaryTopology["event"],
	status: Extract<DurableStageLifecycleStatus, "running" | "completed" | "failed" | "skipped">,
): DurableStageTopology {
	const child = {
		runId: childRunId,
		runName: input.childRunName,
		parentRunId: input.workflowId,
		parentStageId: boundaryId,
		rootRunId: input.rootWorkflowId,
	};
	const identity = {
		version: DURABLE_BOUNDARY_TOPOLOGY_VERSION,
		replayScope: input.replayKey,
		alias: input.alias,
		workflow: input.workflow,
		invocationFingerprint: input.invocationFingerprint,
		child,
	};
	let boundary: DurableWorkflowBoundaryTopology;
	if (event === "start") {
		if (status !== "running") throw invalid(input, "boundary start has a non-running status");
		boundary = { ...identity, event, status };
	} else {
		if (status === "running") throw invalid(input, "boundary terminal has a running status");
		boundary = { ...identity, event, status };
	}
	return {
		version: DURABLE_STAGE_TOPOLOGY_VERSION,
		stageId: boundaryId,
		parentIds: [...parentIds],
		sourceOrder,
		status,
		run: { ...input.runTopology },
		boundary,
	};
}

function stageCheckpoints(checkpoints: readonly DurableCheckpoint[]): DurableStageCheckpoint[] {
	return checkpoints.filter((checkpoint): checkpoint is DurableStageCheckpoint => checkpoint.kind === "stage");
}

function validateScopedIdentities(
	input: Pick<DurableBoundaryDescriptor, "replayKey">,
	checkpoints: readonly DurableCheckpoint[],
): void {
	const prefix = `${input.replayKey}:`;
	for (const checkpoint of checkpoints) {
		const lookupIdentity =
			checkpoint.kind === "tool"
				? checkpoint.argsHash
				: checkpoint.kind === "ui"
					? checkpoint.promptHash
					: checkpoint.replayKey;
		// The boundary start/terminal (including the safe legacy fallback) owns
		// the scope key itself rather than a descendant key.
		if (checkpoint.kind === "stage" && lookupIdentity === input.replayKey) continue;
		if (checkpoint.checkpointId.startsWith(prefix) !== lookupIdentity.startsWith(prefix)) {
			throw invalid(input, "scoped checkpoint identity is not reciprocal");
		}
	}
}

function childStageRecords(stages: readonly DurableStageCheckpoint[], replayKey: string): DurableStageCheckpoint[] {
	const prefix = `${replayKey}:`;
	return stages.filter((checkpoint) => checkpoint.replayKey.startsWith(prefix));
}

function toolNodeIds(checkpoints: readonly DurableCheckpoint[], runId: string): ReadonlySet<string> {
	return new Set(
		checkpoints.flatMap((checkpoint) =>
			checkpoint.kind === "tool" && checkpoint.topology?.run?.runId === runId ? [checkpoint.topology.nodeId] : [],
		),
	);
}

function hasPriorInvocationData(
	checkpoints: readonly DurableCheckpoint[],
	replayKey: string,
	invocationFingerprint: string,
): boolean {
	const prefix = `${replayKey}:`;
	const currentScope = replayKey.includes(`:${invocationFingerprint}:`);
	return checkpoints.some((checkpoint) =>
		checkpoint.kind === "stage"
			? checkpoint.replayKey === replayKey || checkpoint.replayKey.startsWith(prefix)
			: !currentScope && checkpoint.kind === "tool" && checkpoint.checkpointId.startsWith(prefix),
	);
}

function invalid(input: Pick<DurableBoundaryDescriptor, "replayKey">, message: string): DurableNestedTopologyError {
	return new DurableNestedTopologyError(`${message} at ${input.replayKey}`);
}

function validatedInvocationRecords(input: DurableBoundaryDescriptor): {
	readonly stages: readonly DurableStageCheckpoint[];
	readonly start: DurableStageCheckpoint | undefined;
} {
	const checkpoints = input.backend.listCheckpoints(input.workflowId);
	validateScopedIdentities(input, checkpoints);
	const stages = stageCheckpoints(checkpoints);
	const starts = stages.filter(
		(checkpoint) => checkpoint.replayKey === input.replayKey && checkpoint.topology?.boundary?.event === "start",
	);
	if (starts.length > 1) throw invalid(input, "duplicate boundary-start records");
	const start = starts[0];
	if (start === undefined && hasPriorInvocationData(checkpoints, input.replayKey, input.invocationFingerprint)) {
		throw invalid(input, "active scoped checkpoints exist without a boundary-start record");
	}
	if (start !== undefined) validateStartRecord(input, start, stages, checkpoints);
	return { stages, start };
}

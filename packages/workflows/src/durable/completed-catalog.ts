import type { SessionStore } from "@bastani/atomic";
import { flattenTruncatedString } from "../shared/flat-string.js";
import { isReopenableSession } from "../shared/session-transcript.js";
import { stageSessionStore } from "../shared/stage-session-store.js";
import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../shared/store-types.js";
import { boundedToolPayload, boundedToolPayloadRecord, boundedToolText } from "../shared/tool-payload-bounds.js";
import type { WorkflowInputValues, WorkflowSerializableValue } from "../shared/types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import {
	boundaryOwner,
	childRunIdFromDraft,
	childRunStatus,
	childScopedEvidenceExists,
	compareDraftSourceOrder,
	isSyntheticExitedChild,
	mergeStageDraft,
	mergeStageGroup,
	retainReachableRunGroups,
	runTopologyFor,
	type StageDraft,
	validateRunGroups,
	validBoundaryRecordSet,
	validStageGroup,
	workflowChildFromDraft,
} from "./completed-catalog-stage-groups.js";
import { isDurableWorkflowResumable } from "./resume-eligibility.js";
import { resolveDurableEntry } from "./resume-runtime.js";
import { priorRunElapsedMs, RUN_TIMING_CHECKPOINT_NAME, RUN_USAGE_CHECKPOINT_NAME } from "./run-timing.js";
import { WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME } from "./workflow-heartbeat-anchor.js";

/**
 * Reserved run-level tool checkpoints that carry no graph node. They round-trip
 * through the durable envelope like any tool checkpoint, so reconstruction has
 * to skip them or they surface as phantom cached tool nodes.
 */
function isReservedRunCheckpointHash(argsHash: string): boolean {
	return (
		[RUN_TIMING_CHECKPOINT_NAME, RUN_USAGE_CHECKPOINT_NAME].includes(argsHash) ||
		argsHash === WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME
	);
}

import {
	directChildTopologyError,
	groupByDurableStageKey,
	immutableStageGroupError,
} from "./stage-topology-validation.js";
import { workflowToolOutcomeFromValue } from "./tool-outcome.js";
import {
	DURABLE_STAGE_TOPOLOGY_VERSION,
	type DurableCheckpoint,
	type DurableStageCheckpoint,
	type DurableToolCheckpoint,
	type ResumableWorkflowEntry,
} from "./types.js";

export type CompletedWorkflowResolution =
	| { readonly kind: "found"; readonly entry: ResumableWorkflowEntry; readonly snapshot: RunSnapshot }
	| { readonly kind: "malformed"; readonly message: string }
	| { readonly kind: "not_found" }
	| { readonly kind: "stale"; readonly entry: ResumableWorkflowEntry };

interface ReconstructionDrafts {
	readonly stages: readonly StageDraft[];
	readonly tools: readonly DurableToolCheckpoint[];
}

/** Authoritative completed rows. This path is deliberately separate from resumability. */
export function listCompletedFromBackend(backend: DurableWorkflowBackend): readonly ResumableWorkflowEntry[] {
	return backend.listCompletedWorkflows();
}

/** Completed rows whose authoritative stage topology reconstructs safely. */
export async function listOpenableCompletedWorkflows(
	backend: DurableWorkflowBackend,
	sessionStore?: SessionStore,
): Promise<readonly ResumableWorkflowEntry[]> {
	const entries = listCompletedFromBackend(backend);
	const snapshots = await Promise.all(entries.map((entry) => completedWorkflowSnapshot(backend, entry, sessionStore)));
	return entries.filter((_entry, index) => snapshots[index] !== undefined).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function resolveCompletedWorkflow(
	workflowId: string,
	backend: DurableWorkflowBackend,
	openableCatalog?: readonly ResumableWorkflowEntry[],
	sessionStore?: SessionStore,
): Promise<CompletedWorkflowResolution> {
	const resolved = resolveDurableEntry(
		workflowId,
		openableCatalog ?? (await listOpenableCompletedWorkflows(backend, sessionStore)),
	);
	if (resolved !== undefined) {
		if ("kind" in resolved) return { kind: "malformed", message: resolved.message };
		const snapshot = await completedWorkflowSnapshot(backend, resolved, sessionStore);
		if (snapshot === undefined) {
			return { kind: "stale", entry: resolved };
		}
		return { kind: "found", entry: resolved, snapshot };
	}

	const authoritative = resolveDurableEntry(workflowId, listCompletedFromBackend(backend));
	if (authoritative === undefined) return { kind: "not_found" };
	if ("kind" in authoritative) return { kind: "malformed", message: authoritative.message };
	return { kind: "stale", entry: authoritative };
}

export async function completedWorkflowSnapshot(
	backend: DurableWorkflowBackend,
	entry: ResumableWorkflowEntry,
	sessionStore?: SessionStore,
): Promise<RunSnapshot | undefined> {
	const runs = await completedWorkflowRunSnapshots(backend, entry, sessionStore);
	return runs.find((run) => run.id === entry.workflowId);
}

/** Rebuild the root plus every nested child run required by graph expansion. */
export async function completedWorkflowRunSnapshots(
	backend: DurableWorkflowBackend,
	entry: ResumableWorkflowEntry,
	sessionStore?: SessionStore,
): Promise<readonly RunSnapshot[]> {
	const handle = backend.getWorkflow(entry.workflowId);
	if (handle === undefined || (handle.status !== "completed" && handle.status !== "failed")) return [];
	const checkpoints = backend.listCheckpoints(entry.workflowId);
	if (checkpoints.length === 0) return [];
	const selectedStore = sessionStore ?? (await stageSessionStore({ cwd: handle.workflowCwd ?? handle.invocationCwd }));
	try {
		const runs = await Promise.all(
			runSnapshotsFromCheckpoints(
				checkpoints,
				handle.workflowId,
				handle.name,
				handle.updatedAt,
				COMPLETED_RECONSTRUCTION,
			).map(async (run) => ({
				...run,
				stages: await Promise.all(run.stages.map((stage) => validatedStageTranscript(stage, selectedStore))),
			})),
		);
		const rootIndex = runs.findIndex((run) => run.id === handle.workflowId);
		if (rootIndex < 0) return [];
		const rootDuration =
			priorRunElapsedMs(backend, handle.workflowId) ?? Math.max(0, handle.updatedAt - handle.createdAt);
		const root: RunSnapshot = {
			...runs[rootIndex]!,
			inputs: { ...handle.inputs } as WorkflowInputValues,
			status: handle.status,
			startedAt: handle.createdAt,
			endedAt: handle.updatedAt,
			durationMs: rootDuration,
			...(handle.error !== undefined ? { error: handle.error } : {}),
			...(handle.exited !== undefined ? { exited: handle.exited } : {}),
			...(handle.exitReason !== undefined ? { exitReason: handle.exitReason } : {}),
			...(handle.failureKind !== undefined ? { failureKind: handle.failureKind } : {}),
			...(handle.failureCode !== undefined ? { failureCode: handle.failureCode } : {}),
			...(handle.failureRecoverability !== undefined ? { failureRecoverability: handle.failureRecoverability } : {}),
			...(handle.failureDisposition !== undefined ? { failureDisposition: handle.failureDisposition } : {}),
			...(handle.failedToolNodeId !== undefined ? { failedToolNodeId: handle.failedToolNodeId } : {}),
			resumable: handle.resumable ?? false,
		};
		return [root, ...runs.filter((_, index) => index !== rootIndex)];
	} finally {
		if (sessionStore === undefined) await selectedStore.close();
	}
}

/** Rebuild one retained root, including in-progress nested runs, without relaxing topology validation. */
export function durableWorkflowRunSnapshots(
	backend: DurableWorkflowBackend,
	handle: import("./types.js").DurableWorkflowHandle,
): readonly RunSnapshot[] {
	const checkpoints = backend.listCheckpoints(handle.workflowId);
	if (checkpoints.length === 0) {
		return [rootSnapshot(backend, handle, { stages: [], toolNodes: [] })];
	}
	const requiresTerminalTopology = handle.status === "completed" || handle.status === "failed";
	const runs = runSnapshotsFromCheckpoints(
		checkpoints,
		handle.workflowId,
		handle.name,
		handle.updatedAt,
		requiresTerminalTopology ? COMPLETED_RECONSTRUCTION : ACTIVE_INSPECTION_RECONSTRUCTION,
	);
	const rootIndex = runs.findIndex((run) => run.id === handle.workflowId);
	if (rootIndex < 0) return [];
	return [rootSnapshot(backend, handle, runs[rootIndex]!), ...runs.filter((_, index) => index !== rootIndex)];
}

function rootSnapshot(
	backend: DurableWorkflowBackend,
	handle: import("./types.js").DurableWorkflowHandle,
	graph: Pick<RunSnapshot, "stages" | "toolNodes">,
): RunSnapshot {
	const terminal = handle.status === "completed" || handle.status === "failed" || handle.status === "cancelled";
	const priorDurationMs = priorRunElapsedMs(backend, handle.workflowId);
	const terminalDurationMs = priorDurationMs ?? Math.max(0, handle.updatedAt - handle.createdAt);
	return {
		id: handle.workflowId,
		label: handle.label,
		summary: handle.summary,
		summarizedThrough: handle.summarizedThrough,
		name: handle.name,
		inputs: { ...handle.inputs } as WorkflowInputValues,
		status: handle.status,
		stages: graph.stages,
		toolNodes: graph.toolNodes,
		startedAt: handle.createdAt,
		...(terminal
			? { endedAt: handle.updatedAt, durationMs: terminalDurationMs }
			: priorDurationMs === undefined
				? {}
				: { accumulatedDurationMs: priorDurationMs }),
		...(handle.error !== undefined ? { error: handle.error } : {}),
		...(handle.failureKind !== undefined ? { failureKind: handle.failureKind } : {}),
		...(handle.failureCode !== undefined ? { failureCode: handle.failureCode } : {}),
		...(handle.failureRecoverability !== undefined ? { failureRecoverability: handle.failureRecoverability } : {}),
		...(handle.failureDisposition !== undefined ? { failureDisposition: handle.failureDisposition } : {}),
		...(handle.failedToolNodeId !== undefined ? { failedToolNodeId: handle.failedToolNodeId } : {}),
		resumable: isDurableWorkflowResumable(handle),
	};
}

/** Rebuild completed nested runs while a paused root is replaying cached boundaries. */
export function durableNestedRunSnapshots(
	backend: DurableWorkflowBackend,
	rootWorkflowId: string,
): readonly RunSnapshot[] {
	const handle = backend.getWorkflow(rootWorkflowId);
	if (handle === undefined) return [];
	return runSnapshotsFromCheckpoints(
		backend.listCheckpoints(rootWorkflowId),
		rootWorkflowId,
		handle.name,
		handle.updatedAt,
		ACTIVE_INSPECTION_RECONSTRUCTION,
	).filter((run) => run.id !== rootWorkflowId);
}

async function validatedStageTranscript(stage: StageSnapshot, store: SessionStore): Promise<StageSnapshot> {
	if (stage.sessionId !== undefined && (await isReopenableSession(store, stage.sessionId))) return stage;
	const { sessionId: _sessionId, sessionFile: _sessionFile, ...withoutSession } = stage;
	return withoutSession;
}

/** Enumerate checkpoints once so stage and tool nodes share one order domain. */
function checkpointDrafts(checkpoints: readonly DurableCheckpoint[]): ReconstructionDrafts {
	const stageByReplayKey = new Map<string, StageDraft>();
	const toolByHash = new Map<string, DurableToolCheckpoint>();
	checkpoints.forEach((checkpoint, index) => {
		const sequence = index + 1;
		if (checkpoint.kind === "stage") {
			const existing = stageByReplayKey.get(checkpoint.replayKey);
			stageByReplayKey.set(checkpoint.replayKey, mergeStageDraft(existing, checkpoint, sequence));
			return;
		}
		if (checkpoint.kind !== "tool" || isReservedRunCheckpointHash(checkpoint.argsHash)) return;
		const existing = toolByHash.get(checkpoint.argsHash);
		if (existing === undefined || checkpoint.completedAt >= existing.completedAt) {
			toolByHash.set(checkpoint.argsHash, checkpoint);
		}
	});
	return {
		stages: [...stageByReplayKey.values()],
		tools: [...toolByHash.values()],
	};
}

function completedToolNodes(
	checkpoints: readonly DurableToolCheckpoint[],
	runId: string,
	rootRunId: string,
	sourceIds: ReadonlyMap<string, string>,
): ToolNodeSnapshot[] {
	return checkpoints.flatMap((checkpoint) => {
		const topologyRunId = checkpoint.topology?.run?.runId ?? rootRunId;
		if (topologyRunId !== runId) return [];
		const topology = checkpoint.topology;
		if (topology === undefined) return [];
		const outcome =
			checkpoint.outcomeKind === undefined ? undefined : workflowToolOutcomeFromValue(checkpoint.output);
		const failed = checkpoint.outcomeKind === "return_failure" || checkpoint.throwingFailureError !== undefined;
		const failureError =
			checkpoint.throwingFailureError ?? (outcome?.ok === false ? outcome.error.message : undefined);
		return [
			{
				kind: "tool" as const,
				id: topology.nodeId,
				name: checkpoint.name,
				// Restored nodes are recorded into the live store, which session and
				// status surfaces clone and re-serialize, so these inspection copies
				// are bounded. `checkpoint.output` itself stays exact for replay.
				...(checkpoint.args !== undefined ? { args: boundedToolPayloadRecord(checkpoint.args) } : {}),
				...(checkpoint.source !== undefined ? { source: boundedToolText(checkpoint.source) } : {}),
				argsHash: checkpoint.argsHash,
				ordinal: topology.ordinal,
				parentIds: Object.freeze(topology.parentIds.map((parentId) => sourceIds.get(parentId) ?? parentId)),
				...(checkpoint.throwingFailureError === undefined ? { replayed: true } : {}),
				status:
					checkpoint.cancelled === true
						? ("cancelled" as const)
						: failed
							? ("failed" as const)
							: ("cached" as const),
				executionOrder: topology.order,
				...(topology?.startedAt !== undefined ? { startedAt: topology.startedAt } : {}),
				endedAt: topology?.endedAt ?? checkpoint.completedAt,
				...(topology?.startedAt !== undefined
					? { durationMs: Math.max(0, (topology?.endedAt ?? checkpoint.completedAt) - topology.startedAt) }
					: {}),
				...(checkpoint.throwingFailureError === undefined ? { result: boundedToolPayload(checkpoint.output) } : {}),
				...(failed
					? { error: failureError ?? "Invalid durable ctx.tool failure outcome" }
					: { resultSummary: summarizeCompletedToolResult(checkpoint.output) }),
				attachable: false as const,
			},
		];
	});
}

/**
 * Catalog rows are held for the lifetime of a completed-run listing, so this
 * truncation must release the payload it summarizes rather than point into it.
 * See `flattenTruncatedString`.
 */
function summarizeCompletedToolResult(value: WorkflowSerializableValue): string {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) return flattenTruncatedString(String(value).slice(0, 240));
	return serialized.length <= 240 ? serialized : `${flattenTruncatedString(serialized.slice(0, 237))}...`;
}

interface ReconstructionPolicy {
	readonly requireTerminal: boolean;
	readonly retainActive: boolean;
	readonly failOnUnreachable: boolean;
}

const COMPLETED_RECONSTRUCTION: ReconstructionPolicy = {
	requireTerminal: true,
	retainActive: false,
	failOnUnreachable: false,
};
const ACTIVE_INSPECTION_RECONSTRUCTION: ReconstructionPolicy = {
	requireTerminal: false,
	retainActive: true,
	failOnUnreachable: true,
};

function runSnapshotsFromCheckpoints(
	checkpoints: readonly DurableCheckpoint[],
	rootRunId: string,
	rootRunName: string,
	fallbackCompletedAt: number,
	policy: ReconstructionPolicy = COMPLETED_RECONSTRUCTION,
): RunSnapshot[] {
	if (!validBoundaryRecordSet(checkpoints, policy.requireTerminal)) return [];
	const stageRecords = checkpoints.filter(
		(checkpoint): checkpoint is DurableStageCheckpoint => checkpoint.kind === "stage",
	);
	const identityRecords = stageRecords.filter(
		(stage) =>
			stage.topology?.sourceOrder !== undefined ||
			stage.topology?.status !== undefined ||
			stage.topology?.occurrenceKey !== undefined ||
			stage.topology?.boundary !== undefined,
	);
	if (immutableStageGroupError(identityRecords) !== undefined) return [];
	const recordsByGroup = groupByDurableStageKey(stageRecords);
	const candidates = [...recordsByGroup.values()]
		.map((records) => mergeStageGroup(records, stageRecords, checkpoints))
		.filter(
			(draft) =>
				policy.retainActive ||
				draft.topology?.run === undefined ||
				draft.endedAt !== undefined ||
				draft.output !== undefined,
		)
		.sort(compareDraftSourceOrder);
	const drafts = checkpointDrafts(checkpoints);
	const toolCheckpoints = drafts.tools;
	if (toolCheckpoints.some((checkpoint) => checkpoint.topology === undefined)) return [];
	for (const draft of candidates) {
		const boundary = draft.topology?.boundary;
		if (boundary === undefined || childRunIdFromDraft(draft) === undefined) continue;
		if (boundary.replayScope !== draft.replayKey) return [];
		const expectedChildRun = {
			runId: boundary.child.runId,
			runName: boundary.child.runName,
			parentRunId: boundary.child.parentRunId,
			parentStageId: boundary.child.parentStageId,
			rootRunId: boundary.child.rootRunId,
		};
		const childToolIds = new Set(
			toolCheckpoints.flatMap((checkpoint) =>
				checkpoint.topology?.run?.runId === expectedChildRun.runId ? [checkpoint.topology.nodeId] : [],
			),
		);
		if (directChildTopologyError(stageRecords, boundary.replayScope, expectedChildRun, childToolIds) !== undefined)
			return [];
	}
	if (candidates.length === 0 && toolCheckpoints.length === 0) {
		const supportedNonGraphState = checkpoints.every(
			(checkpoint) =>
				checkpoint.kind === "ui" ||
				(checkpoint.kind === "tool" && isReservedRunCheckpointHash(checkpoint.argsHash)),
		);
		if (supportedNonGraphState) {
			return [emptyGraphRun(rootRunId, rootRunName, fallbackCompletedAt)];
		}
		return [];
	}

	const grouped = new Map<string, StageDraft[]>();
	for (const draft of candidates) {
		if (draft.topology?.version !== DURABLE_STAGE_TOPOLOGY_VERSION) return [];
		const runId = draft.topology.run?.runId ?? rootRunId;
		const group = grouped.get(runId) ?? [];
		group.push(draft);
		grouped.set(runId, group);
	}
	for (const checkpoint of toolCheckpoints) {
		const runId = checkpoint.topology?.run?.runId ?? rootRunId;
		if (!grouped.has(runId)) grouped.set(runId, []);
	}
	for (const group of grouped.values()) group.sort(compareDraftSourceOrder);
	const groupedCount = grouped.size;
	retainReachableRunGroups(grouped, rootRunId);
	if (policy.failOnUnreachable && grouped.size !== groupedCount) return [];
	if (!validateRunGroups(grouped, rootRunId, toolCheckpoints, checkpoints)) return [];
	const syntheticChildren: Array<{
		readonly parentRunId: string;
		readonly owner: StageDraft;
		readonly child: NonNullable<StageSnapshot["workflowChild"]>;
	}> = [];
	for (const [parentRunId, runDrafts] of grouped) {
		for (const draft of runDrafts) {
			const child = workflowChildFromDraft(draft);
			if (child?.exited !== true || grouped.has(child.runId)) continue;
			if (
				!isSyntheticExitedChild(draft, parentRunId, child.runId, rootRunId) ||
				childScopedEvidenceExists(checkpoints, draft.replayKey, child.runId)
			) {
				return [];
			}
			syntheticChildren.push({ parentRunId, owner: draft, child });
		}
	}

	const idMaps = new Map<string, Map<string, string>>();
	for (const [runId, runDrafts] of grouped) {
		const ownedTools = toolCheckpoints.filter(
			(checkpoint) => (checkpoint.topology?.run?.runId ?? rootRunId) === runId,
		);
		if (!validStageGroup(runDrafts, runId, rootRunId, ownedTools)) return [];
		const ids = new Map<string, string>();
		let hasIdentityConflict = false;
		runDrafts.forEach((draft) => {
			const completedId = draft.topology!.stageId;
			ids.set(draft.topology!.stageId, completedId);
			for (const sourceId of draft.sourceIds) {
				const existing = ids.get(sourceId);
				if (existing !== undefined && existing !== completedId) hasIdentityConflict = true;
				else ids.set(sourceId, completedId);
			}
		});
		if (hasIdentityConflict) return [];
		for (const checkpoint of toolCheckpoints) {
			const ownerRunId = checkpoint.topology?.run?.runId ?? rootRunId;
			const sourceId = checkpoint.topology?.nodeId ?? checkpoint.checkpointId;
			if (ownerRunId === runId) ids.set(sourceId, sourceId);
		}
		idMaps.set(runId, ids);
	}

	const runs: RunSnapshot[] = [];
	const emittedRunIds = new Set<string>();
	for (const [runId, runDrafts] of grouped) {
		const ids = idMaps.get(runId)!;
		const ownedTools = toolCheckpoints.filter(
			(checkpoint) => (checkpoint.topology?.run?.runId ?? rootRunId) === runId,
		);
		const hasUnknownParents =
			runDrafts.some((draft) => draft.topology!.parentIds.some((parentId) => !ids.has(parentId))) ||
			ownedTools.some(
				(checkpoint) => checkpoint.topology?.parentIds.some((parentId) => !ids.has(parentId)) === true,
			);
		if (hasUnknownParents) return [];
		const stages = runDrafts.map((draft) =>
			stageSnapshotFromDraft(
				draft,
				ids.get(draft.topology!.stageId)!,
				draft.topology!.parentIds.map((parentId) => ids.get(parentId)!),
			),
		);
		const toolNodes = completedToolNodes(toolCheckpoints, runId, rootRunId, ids);
		const run = runTopologyFor(runDrafts, ownedTools);
		const startedAt = Math.min(
			...stages.map((stage) => stage.startedAt ?? fallbackCompletedAt),
			...toolNodes.map((tool) => tool.startedAt ?? tool.endedAt ?? fallbackCompletedAt),
		);
		const endedAt = Math.max(
			...stages.map((stage) => stage.endedAt ?? fallbackCompletedAt),
			...toolNodes.map((tool) => tool.endedAt ?? fallbackCompletedAt),
		);
		const owner = runId === rootRunId ? undefined : boundaryOwner(grouped, runId);
		const status = owner === undefined ? "completed" : childRunStatus(owner);
		const terminal = status !== "running" && status !== "pending" && status !== "paused" && status !== "blocked";
		const parentRunId = run?.parentRunId ?? rootRunId;
		const boundarySourceId = grouped.get(parentRunId)?.find((draft) => childRunIdFromDraft(draft) === runId)
			?.topology?.stageId;
		const declaredParentStageId =
			run?.parentStageId === undefined ? undefined : idMaps.get(parentRunId)?.get(run.parentStageId);
		const parentStageId =
			declaredParentStageId ??
			(boundarySourceId === undefined ? undefined : idMaps.get(parentRunId)?.get(boundarySourceId));
		const ownerChild = owner === undefined ? undefined : workflowChildFromDraft(owner);
		runs.push({
			id: runId,
			name: run?.runName ?? rootRunName,
			inputs: {},
			status,
			stages,
			toolNodes,
			startedAt,
			...(terminal ? { endedAt, durationMs: Math.max(0, endedAt - startedAt) } : {}),
			...(run?.parentRunId !== undefined ? { parentRunId: run.parentRunId } : {}),
			...(parentStageId !== undefined ? { parentStageId } : {}),
			...(run?.rootRunId !== undefined ? { rootRunId: run.rootRunId } : {}),
			...(ownerChild?.exited === true
				? {
						result: ownerChild.outputs,
						exited: true,
						...(ownerChild.exitReason !== undefined ? { exitReason: ownerChild.exitReason } : {}),
					}
				: {}),
			resumable: false,
		});
		emittedRunIds.add(runId);
	}
	for (const { parentRunId, owner, child } of syntheticChildren) {
		if (!emittedRunIds.has(parentRunId)) return [];
		const topology = owner.topology!;
		const boundary = topology.boundary!;
		const parentStageId = idMaps.get(parentRunId)?.get(topology.stageId);
		if (parentStageId === undefined) return [];
		const startedAt = owner.startedAt ?? owner.firstCompletedAt;
		const endedAt = owner.endedAt ?? owner.firstCompletedAt;
		runs.push({
			id: child.runId,
			name: boundary.child.runName,
			inputs: {},
			status: child.status,
			stages: [],
			toolNodes: [],
			startedAt,
			endedAt,
			durationMs: Math.max(0, endedAt - startedAt),
			parentRunId,
			parentStageId,
			rootRunId: boundary.child.rootRunId,
			result: child.outputs,
			exited: true,
			...(child.exitReason !== undefined ? { exitReason: child.exitReason } : {}),
			resumable: false,
		});
	}
	return runs;
}

function stageSnapshotFromDraft(draft: StageDraft, id: string, parentIds: readonly string[]): StageSnapshot {
	const status = draft.topology?.status ?? "completed";
	const startedAt = draft.startedAt ?? draft.firstCompletedAt;
	const endedAt = draft.endedAt ?? (status === "running" ? undefined : draft.firstCompletedAt);
	const workflowChild = workflowChildFromDraft(draft);
	const boundary = draft.topology?.boundary;
	return {
		id,
		name: draft.name,
		status,
		parentIds,
		executionOrder: draft.topology?.order ?? draft.topology?.sourceOrder ?? draft.firstSequence,
		startedAt,
		...(endedAt !== undefined ? { endedAt } : {}),
		...(endedAt !== undefined ? { durationMs: draft.durationMs ?? Math.max(0, endedAt - startedAt) } : {}),
		...(stageResult(draft) !== undefined ? { result: stageResult(draft) } : {}),
		replayKey: draft.replayKey,
		toolEvents: [],
		attachable: false,
		...(workflowChild !== undefined ? { workflowChild } : {}),
		...(workflowChild === undefined && boundary !== undefined && status !== "failed" && status !== "skipped"
			? {
					workflowChildRun: {
						alias: boundary.alias,
						workflow: boundary.workflow,
						runId: boundary.child.runId,
					},
				}
			: {}),
		...(draft.sessionId !== undefined ? { sessionId: draft.sessionId } : {}),
		...(draft.sessionFile !== undefined ? { sessionFile: draft.sessionFile } : {}),
		...(draft.model !== undefined ? { model: draft.model } : {}),
		...(draft.thinkingLevel !== undefined ? { thinkingLevel: draft.thinkingLevel } : {}),
		...(draft.attemptedModels !== undefined ? { attemptedModels: draft.attemptedModels } : {}),
		...(draft.modelAttempts !== undefined ? { modelAttempts: draft.modelAttempts } : {}),
		...(draft.routerSelection !== undefined ? { routerSelection: draft.routerSelection } : {}),
	};
}

function stageResult(draft: StageDraft): string | undefined {
	if (draft.result !== undefined) return draft.result;
	if (draft.output === undefined) return undefined;
	return typeof draft.output === "string" ? draft.output : JSON.stringify(draft.output);
}

function emptyGraphRun(runId: string, runName: string, completedAt: number): RunSnapshot {
	return {
		id: runId,
		name: runName,
		inputs: {},
		status: "completed",
		stages: [],
		toolNodes: [],
		startedAt: completedAt,
		endedAt: completedAt,
		durationMs: 0,
		resumable: false,
	};
}

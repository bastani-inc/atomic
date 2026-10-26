import { appendRunBlocked, appendRunEnd } from "../../shared/persistence-session-entries.js";
import type { Store } from "../../shared/store.js";
import { isTerminalRunStatus } from "../../shared/store-internal.js";
import type {
	RunBudgetState,
	RunFailureClassification,
	RunSnapshot,
	RunStatus,
	StageSnapshot,
	WorkflowFailureCode,
	WorkflowFailureDisposition,
	WorkflowFailureKind,
	WorkflowFailureRecoverability,
} from "../../shared/store-types.js";
import type { WorkflowOutputValues, WorkflowPersistencePort } from "../../shared/types.js";
import type { WorkflowFailure } from "../../shared/workflow-failures.js";
import { runFailureClassification } from "../../shared/workflow-failures-classifier.js";
import { safeExecutorAggregateErrorItems } from "./executor-abort.js";
import type { RunOpts, RunResult } from "./executor-types.js";

export const EMPTY_WORKFLOW_GRAPH_ERROR_MESSAGE =
	"Workflow run completed without creating any workflow stages or durable tool nodes. Create tracked execution with ctx.stage(), ctx.task(), ctx.chain(), ctx.parallel(), ctx.workflow(), or ctx.tool().";

export function assertWorkflowCreatedExecution(runSnapshot: RunSnapshot): void {
	if (runSnapshot.stages.length > 0 || runSnapshot.toolNodes.length > 0) return;
	throw new Error(EMPTY_WORKFLOW_GRAPH_ERROR_MESSAGE);
}

export async function appendRunEndWhenRecorded(
	persistence: WorkflowPersistencePort | undefined,
	recorded: boolean,
	payload: {
		readonly runId: string;
		readonly status: RunStatus;
		readonly result?: WorkflowOutputValues;
		readonly error?: string;
		readonly exited?: boolean;
		readonly exitReason?: string;
		readonly failureKind?: WorkflowFailureKind;
		readonly failureCode?: WorkflowFailureCode;
		readonly failureRecoverability?: WorkflowFailureRecoverability;
		readonly failureDisposition?: WorkflowFailureDisposition;
		readonly failureMessage?: string;
		readonly failedStageId?: string;
		readonly failedToolNodeId?: string;
		readonly failedToolNode?: import("../../shared/store-types.js").ToolNodeSnapshot;
		readonly resumable?: boolean;
		readonly retryAfterMs?: number;
		readonly ts: number;
	},
): Promise<void> {
	if (!persistence || !recorded) return;
	await appendRunEnd(persistence, payload);
}

/**
 * A run or stage's recorded failure classification, when it recorded one (#4031). Every recorded field is
 * kept as recorded, `resumable` included; only fields it did not record are derived from its code or kind.
 */
export function recordedFailureClassification(source: {
	readonly failureKind?: WorkflowFailureKind;
	readonly failureCode?: WorkflowFailureCode;
	readonly failureRecoverability?: WorkflowFailureRecoverability;
	readonly failureDisposition?: WorkflowFailureDisposition;
	readonly retryAfterMs?: number;
	readonly resumable?: boolean;
}): RunFailureClassification | undefined {
	if (source.failureKind === undefined) return undefined;
	return runFailureClassification({
		kind: source.failureKind,
		...(source.failureCode !== undefined ? { code: source.failureCode } : {}),
		...(source.failureRecoverability !== undefined ? { recoverability: source.failureRecoverability } : {}),
		...(source.failureDisposition !== undefined ? { disposition: source.failureDisposition } : {}),
		...(source.retryAfterMs !== undefined ? { retryAfterMs: source.retryAfterMs } : {}),
		...(source.resumable !== undefined ? { resumable: source.resumable } : {}),
	});
}

function failureOf(metadata: Parameters<typeof recordedFailureClassification>[0]): Pick<RunResult, "failure"> {
	const failure = recordedFailureClassification(metadata);
	return failure === undefined ? {} : { failure };
}

export function runResultFromSnapshot(snapshot: RunSnapshot): RunResult {
	const failure = recordedFailureClassification(snapshot);
	return {
		runId: snapshot.id,
		status: snapshot.status,
		...(snapshot.result !== undefined ? { result: snapshot.result } : {}),
		...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
		...(snapshot.failedToolNodeId !== undefined ? { failedToolNodeId: snapshot.failedToolNodeId } : {}),
		...(snapshot.exited !== undefined ? { exited: snapshot.exited } : {}),
		...(snapshot.exitReason !== undefined ? { exitReason: snapshot.exitReason } : {}),
		...(failure !== undefined ? { failure } : {}),
		stages: [...snapshot.stages],
		toolNodes: [...snapshot.toolNodes],
	};
}

export function reconcileTerminalRunResult(
	runId: string,
	runSnapshot: RunSnapshot,
	activeStore: Store,
	fallback: Omit<RunResult, "runId" | "stages" | "toolNodes">,
	onRunEnd: RunOpts["onRunEnd"],
): RunResult {
	const canonical = activeStore
		.runs()
		.find((snapshot) => snapshot.id === runId && isTerminalRunStatus(snapshot.status));
	const result =
		canonical !== undefined
			? runResultFromSnapshot(canonical)
			: {
					runId,
					...fallback,
					stages: [...runSnapshot.stages],
					toolNodes: [...runSnapshot.toolNodes],
				};
	onRunEnd?.(runId, result.status, result.result, result.error, result.exitReason);
	return result;
}

export interface RunFailureMetadata {
	readonly errorMessage: string;
	readonly failureKind: WorkflowFailureKind;
	readonly failureCode?: WorkflowFailureCode;
	readonly failureRecoverability?: WorkflowFailureRecoverability;
	readonly failureDisposition?: WorkflowFailureDisposition;
	readonly failureMessage: string;
	readonly failedStageId?: string;
	readonly failedToolNodeId?: string;
	readonly resumable: boolean;
	readonly retryAfterMs?: number;
	readonly endedAt?: number;
	readonly result?: WorkflowOutputValues;
	readonly budgetState?: RunBudgetState;
}

/**
 * Apply failure fields to a live stage. Executor callers invoke this next to
 * a version-bumping stage store method, with no intervening asynchronous work.
 */
export function applyFailureToStage(stage: StageSnapshot, failure: WorkflowFailure): void {
	stage.status = "failed";
	stage.error = failure.userMessage;
	stage.failureKind = failure.kind;
	stage.failureCode = failure.code;
	stage.failureRecoverability = failure.recoverability;
	stage.failureDisposition = failure.disposition;
	stage.retryAfterMs = failure.retryAfterMs;
	stage.failureMessage = failure.message;
}

export function runFailureMetadata(failure: WorkflowFailure, stages: readonly StageSnapshot[]): RunFailureMetadata {
	const failedStage = stages.find((stage) => stage.status === "failed");
	const failureKind = failedStage?.failureKind ?? failure.kind;
	const failureCode = failedStage?.failureCode ?? failure.code;
	const failureRecoverability = failedStage?.failureRecoverability ?? failure.recoverability;
	const failureDisposition = failedStage?.failureDisposition ?? failure.disposition;
	const retryAfterMs = failedStage?.retryAfterMs ?? failure.retryAfterMs;

	return {
		errorMessage: failedStage?.error ?? failure.userMessage,
		failureKind,
		...(failureCode !== undefined ? { failureCode } : {}),
		failureRecoverability,
		failureDisposition,
		failureMessage: failedStage?.failureMessage ?? failure.message,
		...(failedStage !== undefined ? { failedStageId: failedStage.id } : {}),
		resumable: failure.resumable,
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
	};
}

export interface SelectedRunFailureMetadata extends RunFailureMetadata {
	readonly failedStageIds: readonly string[];
}

function stageDispositionResumable(disposition: WorkflowFailureDisposition | undefined, fallback: boolean): boolean {
	if (disposition === "terminal_killed") return false;
	if (disposition === "active_blocked") return true;
	return fallback;
}

function runFailureMetadataFromStage(fallbackFailure: WorkflowFailure, stage: StageSnapshot): RunFailureMetadata {
	const failureKind = stage.failureKind ?? fallbackFailure.kind;
	const failureCode = stage.failureCode ?? fallbackFailure.code;
	const failureRecoverability = stage.failureRecoverability ?? fallbackFailure.recoverability;
	const failureDisposition = stage.failureDisposition ?? fallbackFailure.disposition;
	const retryAfterMs = stage.retryAfterMs ?? fallbackFailure.retryAfterMs;

	return {
		errorMessage: stage.error ?? fallbackFailure.userMessage,
		failureKind,
		...(failureCode !== undefined ? { failureCode } : {}),
		failureRecoverability,
		failureDisposition,
		failureMessage: stage.failureMessage ?? fallbackFailure.message,
		failedStageId: stage.id,
		resumable: stageDispositionResumable(failureDisposition, fallbackFailure.resumable),
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
	};
}

function runFailureMetadataFromFailure(
	failure: WorkflowFailure,
	failedStage: StageSnapshot | undefined,
): RunFailureMetadata {
	return {
		errorMessage: failedStage?.error ?? failure.userMessage,
		failureKind: failure.kind,
		...(failure.code !== undefined ? { failureCode: failure.code } : {}),
		failureRecoverability: failure.recoverability,
		failureDisposition: failure.disposition,
		failureMessage: failedStage?.failureMessage ?? failure.message,
		...(failedStage !== undefined ? { failedStageId: failedStage.id } : {}),
		resumable: failure.resumable,
		...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
	};
}

function aggregateInnerFailures(
	error: unknown,
	classifyFailure: (error: unknown) => WorkflowFailure,
): readonly WorkflowFailure[] {
	return safeExecutorAggregateErrorItems(error).map((innerError) => classifyFailure(innerError));
}

type StageFailureCandidate = {
	readonly source: "stage";
	readonly stage: StageSnapshot;
	readonly disposition: WorkflowFailureDisposition;
	readonly recoverability: WorkflowFailureRecoverability;
};

type AggregateFailureCandidate = {
	readonly source: "aggregate";
	readonly failure: WorkflowFailure;
	readonly disposition: WorkflowFailureDisposition;
	readonly recoverability: WorkflowFailureRecoverability;
};

type OuterFailureCandidate = {
	readonly source: "outer";
	readonly failure: WorkflowFailure;
	readonly disposition: WorkflowFailureDisposition;
	readonly recoverability: WorkflowFailureRecoverability;
};

type FailureCandidate = StageFailureCandidate | AggregateFailureCandidate | OuterFailureCandidate;

function stageFailureCandidate(stage: StageSnapshot): StageFailureCandidate {
	return {
		source: "stage",
		stage,
		disposition: stage.failureDisposition ?? "terminal_failed",
		recoverability: stage.failureRecoverability ?? "unknown",
	};
}

function aggregateFailureCandidate(failure: WorkflowFailure): AggregateFailureCandidate {
	return {
		source: "aggregate",
		failure,
		disposition: failure.disposition,
		recoverability: failure.recoverability,
	};
}

function outerFailureCandidate(failure: WorkflowFailure): OuterFailureCandidate {
	return {
		source: "outer",
		failure,
		disposition: failure.disposition,
		recoverability: failure.recoverability,
	};
}

function isRecoverableActiveBlockedCandidate(candidate: FailureCandidate): boolean {
	return candidate.disposition === "active_blocked" && candidate.recoverability === "recoverable";
}

function isAggregateWrapper(error: unknown): boolean {
	return safeExecutorAggregateErrorItems(error).length > 0;
}

function runFailureMetadataFromCandidate(
	fallbackFailure: WorkflowFailure,
	candidate: FailureCandidate,
	thrownError: unknown,
): RunFailureMetadata {
	let metadata: RunFailureMetadata;
	switch (candidate.source) {
		case "stage":
			metadata = runFailureMetadataFromStage(fallbackFailure, candidate.stage);
			break;
		case "aggregate":
		case "outer":
			metadata = runFailureMetadataFromFailure(candidate.failure, undefined);
			break;
	}

	if (candidate.disposition === "terminal_failed" && isAggregateWrapper(thrownError)) {
		return { ...metadata, errorMessage: fallbackFailure.userMessage };
	}
	return metadata;
}

function failedStageIdsForCandidate(
	candidate: FailureCandidate,
	failedStages: readonly StageSnapshot[],
): readonly string[] {
	switch (candidate.source) {
		case "aggregate":
			return failedStages.map((stage) => stage.id);
		case "outer":
			return [];
		case "stage":
			return failedStages
				.filter((stage) => (stage.failureDisposition ?? "terminal_failed") === candidate.disposition)
				.map((stage) => stage.id);
	}
}

function selectedMetadata(metadata: RunFailureMetadata, failedStageIds: readonly string[]): SelectedRunFailureMetadata {
	return { ...metadata, failedStageIds };
}

export function selectRunFailureDisposition(input: {
	readonly outerFailure: WorkflowFailure;
	readonly thrownError: unknown;
	readonly stages: readonly StageSnapshot[];
	readonly classifyFailure: (error: unknown) => WorkflowFailure;
}): SelectedRunFailureMetadata {
	const failedStages = input.stages.filter((stage) => stage.status === "failed");
	const failedStageIds = failedStages.map((stage) => stage.id);
	const aggregateFailures = aggregateInnerFailures(input.thrownError, input.classifyFailure);
	const candidates: readonly FailureCandidate[] = [
		...failedStages.map(stageFailureCandidate),
		...aggregateFailures.map(aggregateFailureCandidate),
		outerFailureCandidate(input.outerFailure),
	];

	const terminalKilledCandidate = candidates.find((candidate) => candidate.disposition === "terminal_killed");
	if (terminalKilledCandidate !== undefined) {
		return selectedMetadata(
			runFailureMetadataFromCandidate(input.outerFailure, terminalKilledCandidate, input.thrownError),
			failedStageIdsForCandidate(terminalKilledCandidate, failedStages),
		);
	}

	const terminalFailedCandidate = candidates.find((candidate) => candidate.disposition === "terminal_failed");
	if (terminalFailedCandidate !== undefined) {
		return selectedMetadata(
			runFailureMetadataFromCandidate(input.outerFailure, terminalFailedCandidate, input.thrownError),
			failedStageIdsForCandidate(terminalFailedCandidate, failedStages),
		);
	}

	const recoverableBlockedCandidate = candidates.find(isRecoverableActiveBlockedCandidate);
	if (recoverableBlockedCandidate !== undefined && candidates.every(isRecoverableActiveBlockedCandidate)) {
		return selectedMetadata(
			runFailureMetadataFromCandidate(input.outerFailure, recoverableBlockedCandidate, input.thrownError),
			failedStageIds,
		);
	}

	return selectedMetadata(runFailureMetadata(input.outerFailure, input.stages), failedStageIds);
}

/** Stage-less non-cancellation errors are startup failures, not killed runs. */
export function normalizeStageLessFailureMetadata(
	metadata: SelectedRunFailureMetadata,
	stageCount: number,
): SelectedRunFailureMetadata {
	if (metadata.failureDisposition !== "terminal_killed" || metadata.failureKind === "cancelled" || stageCount > 0) {
		return metadata;
	}
	return { ...metadata, failureDisposition: "terminal_failed" };
}

/** A cancellation-shaped thrown error fails unless the run arbiter observed cancellation first. */
export function normalizeFailureWinnerMetadata(metadata: SelectedRunFailureMetadata): SelectedRunFailureMetadata {
	if (metadata.failureKind !== "cancelled" && metadata.failureCode !== "cancelled") return metadata;
	return {
		...metadata,
		failureKind: "unknown",
		failureCode: "unknown",
		failureRecoverability: "unknown",
		failureDisposition: "terminal_failed",
		resumable: true,
	};
}

export function stageReplayFields(
	stage: StageSnapshot,
): Partial<Pick<StageSnapshot, "replayKey" | "replayedFromStageId" | "replayed">> {
	return {
		...(stage.replayKey !== undefined ? { replayKey: stage.replayKey } : {}),
		...(stage.replayedFromStageId !== undefined ? { replayedFromStageId: stage.replayedFromStageId } : {}),
		...(stage.replayed !== undefined ? { replayed: stage.replayed } : {}),
	};
}

export async function finalizeKilled(
	runId: string,
	runSnapshot: RunSnapshot,
	activeStore: Store,
	persistence: WorkflowPersistencePort | undefined,
	onRunEnd: RunOpts["onRunEnd"],
): Promise<RunResult> {
	const errorMessage = "workflow killed";
	const metadata = {
		failureKind: "cancelled" as const,
		failureCode: "cancelled" as const,
		failureRecoverability: "non_recoverable" as const,
		failureDisposition: "terminal_killed" as const,
		failureMessage: errorMessage,
		resumable: false,
	};
	const recorded = activeStore.recordRunEnd(runId, "killed", undefined, errorMessage, metadata);
	await appendRunEndWhenRecorded(persistence, recorded, {
		runId,
		status: "killed",
		error: errorMessage,
		...metadata,
		ts: Date.now(),
	});
	return reconcileTerminalRunResult(
		runId,
		runSnapshot,
		activeStore,
		{ status: "killed", error: errorMessage },
		onRunEnd,
	);
}

export async function finalizeKilledByFailure(
	runId: string,
	runSnapshot: RunSnapshot,
	activeStore: Store,
	persistence: WorkflowPersistencePort | undefined,
	onRunEnd: RunOpts["onRunEnd"],
	metadata: RunFailureMetadata,
): Promise<RunResult> {
	const recorded = activeStore.recordRunEnd(runId, "killed", undefined, metadata.errorMessage, metadata);
	await appendRunEndWhenRecorded(persistence, recorded, {
		runId,
		status: "killed",
		error: metadata.errorMessage,
		failureKind: metadata.failureKind,
		...(metadata.failureCode !== undefined ? { failureCode: metadata.failureCode } : {}),
		...(metadata.failureRecoverability !== undefined
			? { failureRecoverability: metadata.failureRecoverability }
			: {}),
		...(metadata.failureDisposition !== undefined ? { failureDisposition: metadata.failureDisposition } : {}),
		failureMessage: metadata.failureMessage,
		...(metadata.failedStageId !== undefined ? { failedStageId: metadata.failedStageId } : {}),
		resumable: false,
		...(metadata.retryAfterMs !== undefined ? { retryAfterMs: metadata.retryAfterMs } : {}),
		ts: Date.now(),
	});
	return reconcileTerminalRunResult(
		runId,
		runSnapshot,
		activeStore,
		{ status: "killed", error: metadata.errorMessage, ...failureOf(metadata) },
		onRunEnd,
	);
}
export async function recordActiveBlockedFailure(
	runId: string,
	runSnapshot: RunSnapshot,
	activeStore: Store,
	persistence: WorkflowPersistencePort | undefined,
	metadata: RunFailureMetadata & { readonly failureRecoverability: "recoverable" },
): Promise<RunResult> {
	const blockedAt = Date.now();
	const endedAt = metadata.budgetState?.systemOwnedStop === true ? blockedAt : undefined;
	const recorded = activeStore.recordRunBlocked(runId, metadata.errorMessage, {
		failureKind: metadata.failureKind,
		...(metadata.failureCode !== undefined ? { failureCode: metadata.failureCode } : {}),
		failureRecoverability: "recoverable",
		...(metadata.failureDisposition !== undefined ? { failureDisposition: metadata.failureDisposition } : {}),
		failureMessage: metadata.failureMessage,
		...(metadata.failedStageId !== undefined ? { failedStageId: metadata.failedStageId } : {}),
		resumable: true,
		...(metadata.retryAfterMs !== undefined ? { retryAfterMs: metadata.retryAfterMs } : {}),
		...(endedAt !== undefined ? { endedAt } : {}),
		...(metadata.result !== undefined ? { result: metadata.result } : {}),
		...(metadata.budgetState !== undefined ? { budgetState: metadata.budgetState } : {}),
		blockedAt,
	});
	if (recorded && persistence !== undefined) {
		await appendRunBlocked(persistence, {
			runId,
			...(metadata.failedStageId !== undefined ? { failedStageId: metadata.failedStageId } : {}),
			error: metadata.errorMessage,
			failureKind: metadata.failureKind,
			...(metadata.failureCode !== undefined ? { failureCode: metadata.failureCode } : {}),
			failureMessage: metadata.failureMessage,
			failureRecoverability: "recoverable",
			...(metadata.failureDisposition !== undefined ? { failureDisposition: metadata.failureDisposition } : {}),
			...(metadata.retryAfterMs !== undefined ? { retryAfterMs: metadata.retryAfterMs } : {}),
			resumable: true,
			...(endedAt !== undefined ? { endedAt } : {}),
			...(metadata.result !== undefined ? { result: metadata.result } : {}),
			...(metadata.budgetState !== undefined ? { budgetState: metadata.budgetState } : {}),
			ts: blockedAt,
		});
	}
	const failure = recordedFailureClassification({ ...metadata, failureRecoverability: "recoverable" });
	return {
		runId,
		status: "running",
		...(metadata.result !== undefined ? { result: metadata.result } : {}),
		error: metadata.errorMessage,
		...(failure !== undefined ? { failure } : {}),
		stages: [...runSnapshot.stages],
		toolNodes: [...runSnapshot.toolNodes],
	};
}

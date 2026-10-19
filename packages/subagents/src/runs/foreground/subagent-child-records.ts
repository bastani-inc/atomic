import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@bastani/atomic";
import {
	isSubagentChildRecord,
	observeSubagentChildRecord,
	SUBAGENT_CHILD_RECORD_TYPE,
	subagentChildCardRecord,
} from "./subagent-child-card-state.js";

export { isSubagentChildRecord, SUBAGENT_CHILD_RECORD_TYPE };

export type SubagentChildOwner =
	| { readonly kind: "session"; readonly sessionId: string }
	| {
			readonly kind: "workflow-stage";
			readonly sessionId: string;
			readonly workflowRunId: string;
			readonly workflowStageId: string;
			readonly workflowStageName: string;
	  };

/**
 * One durable observation of a launched child. The latest record for a child id
 * is authoritative: `running` means the child had not settled when it was written,
 * `terminal` means it settled: completed, failed, was interrupted, paused or quit, or was stopped
 * for good. Session recovery restores `running` children and those its workflow stage's pause stopped
 * (`stage-paused`); an explicit `resume` also reopens a settled child unless its `terminalStatus` is
 * non-resumable (`killed`, `stage-closed`, `gone`).
 */
export interface SubagentChildRecord {
	readonly version: 1;
	readonly childId: string;
	readonly runId: string;
	readonly index: number;
	readonly agent: string;
	readonly state: "running" | "terminal";
	readonly cwd: string;
	readonly owner: SubagentChildOwner;
	readonly taskId?: string;
	/** Id of the child's own session; with no `childSessionFile` it is reopened by id from the owner's session store. */
	readonly childSessionId?: string;
	/** Present only for file-backed (JSONL) child sessions; database-backed sessions have no session file. */
	readonly childSessionFile?: string;
	/** The model (`provider/id`) and thinking level the child actually started on, once its session was created. */
	readonly launchModel?: string;
	readonly launchThinkingLevel?: string;
	/**
	 * The leaf entry of the child's own session when its launch model and thinking level were recorded (`null`
	 * for an empty session). Model and thinking changes the child's session records after it are the child's own.
	 */
	readonly launchLeafId?: string | null;
	readonly intercomTarget?: string;
	readonly intercomGroup?: string;
	readonly orchestratorTarget?: string;
	readonly terminalStatus?: string;
}

export type SubagentChildRecordInput = Omit<SubagentChildRecord, "version" | "childId" | "owner">;

export interface SubagentChildRecordSink {
	record(input: SubagentChildRecordInput): void;
	/** Whether the owner is a workflow stage whose generation is closing for good, not merely interrupted. */
	ownerEndedForGood?(): boolean;
	/** Settles once every record this sink was given has been appended. */
	flushed?(): Promise<void>;
}

/** `terminalStatus` of a child whose workflow stage finished, or whose run ended or was cancelled; never resumable. */
export const SUBAGENT_CHILD_STAGE_CLOSED_STATUS = "stage-closed";

/**
 * `terminalStatus` of a child stopped because its workflow stage paused: the run was paused or quit, Atomic exited,
 * or the session was switched. It stays resumable, and is restored when its stage resumes from its session (#3760).
 */
export const SUBAGENT_CHILD_STAGE_PAUSED_STATUS = "stage-paused";

/** Whether session recovery restores this child: it had not settled, or its stage's pause stopped it (#3760). */
export function isRestorableSubagentChild(record: SubagentChildRecord): boolean {
	return (
		record.state === "running" ||
		(record.state === "terminal" && record.terminalStatus === SUBAGENT_CHILD_STAGE_PAUSED_STATUS)
	);
}

/**
 * Workflow-stage extension state the workflows extension sets before it closes a stage generation for good. Without
 * it a closing stage was interrupted (Atomic exited, or the run was paused), and its children stay restorable (#3760).
 */
export const WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE = "atomic:workflow-stage-closed-for-good";

/** `terminalStatus` of a child that could not be restored after a restart and was reported gone to its owner. */
export const SUBAGENT_CHILD_GONE_STATUS = "gone";

const ENDED_STATUSES: ReadonlySet<string> = new Set([
	"killed",
	SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
	SUBAGENT_CHILD_GONE_STATUS,
]);

/**
 * Whether a workflow stage closing for good ends this settled child: every one does, completed, failed, interrupted,
 * paused or quit. Running children end when their task settles.
 */
function endsWithStage(record: SubagentChildRecord): boolean {
	return record.state === "terminal" && !ENDED_STATUSES.has(record.terminalStatus ?? "");
}

export function subagentChildId(runId: string, index: number): string {
	return `${runId}:${index}`;
}

export function subagentChildOwner(
	ctx: Pick<ExtensionContext, "sessionManager" | "orchestrationContext">,
): SubagentChildOwner {
	const sessionId = ctx.sessionManager.getSessionId();
	const orchestration = ctx.orchestrationContext;
	return orchestration?.kind === "workflow-stage"
		? {
				kind: "workflow-stage",
				sessionId,
				workflowRunId: orchestration.workflowRunId,
				workflowStageId: orchestration.workflowStageId,
				workflowStageName: orchestration.workflowStageName,
			}
		: { kind: "session", sessionId };
}

const appendChains = new Map<string, Promise<void>>();

/** Append records of one owner in order, across every sink of that owner. */
function appendInOrder(pi: Pick<ExtensionAPI, "appendEntry">, record: SubagentChildRecord): Promise<void> {
	observeSubagentChildRecord(record);
	const key = record.owner.sessionId;
	const appended = (appendChains.get(key) ?? Promise.resolve())
		.then(() => pi.appendEntry(SUBAGENT_CHILD_RECORD_TYPE, record))
		.catch(() => undefined);
	appendChains.set(key, appended);
	void appended.then(() => {
		if (appendChains.get(key) === appended) appendChains.delete(key);
	});
	return appended;
}

interface StageChildren {
	readonly closeSignal: AbortSignal;
	readonly childIds: Set<string>;
	readonly endedForGood: () => boolean;
	readonly end: (childId: string) => void;
}

const stageChildren = new WeakMap<AbortSignal, StageChildren>();

/**
 * Watch the children a workflow stage owns, so that when the stage generation closes for good every settled child,
 * quit ones included, is recorded `stage-closed`: resume then names why it cannot continue (#3760).
 */
export function watchWorkflowStageSubagentChildren(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ctx: Pick<ExtensionContext, "sessionManager" | "orchestrationContext">,
): StageChildren | undefined {
	const orchestration = ctx.orchestrationContext;
	const admission = orchestration?.kind === "workflow-stage" ? orchestration.messageAdmission : undefined;
	const closeSignal = admission?.boundary.closeSignal;
	if (!admission || !closeSignal) return undefined;
	const existing = stageChildren.get(closeSignal);
	if (existing) return existing;
	const owner = subagentChildOwner(ctx);
	const sessionManager = ctx.sessionManager;
	const endedForGood = () => admission.extensionState.has(WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE);
	const end = (childId: string, persisted?: SubagentChildRecord) => {
		const latest = subagentChildCardRecord(childId, "") ?? persisted;
		if (!endedForGood() || latest?.owner?.sessionId !== owner.sessionId || !endsWithStage(latest)) return;
		void appendInOrder(pi, { ...latest, terminalStatus: SUBAGENT_CHILD_STAGE_CLOSED_STATUS });
	};
	const watched: StageChildren = { closeSignal, childIds: new Set(), endedForGood, end };
	stageChildren.set(closeSignal, watched);
	const endAll = () => {
		if (!endedForGood()) return;
		const persisted = readSubagentChildRecords(sessionManager.getEntries(), owner.sessionId);
		for (const childId of new Set([...persisted.keys(), ...watched.childIds])) end(childId, persisted.get(childId));
	};
	if (closeSignal.aborted) endAll();
	else closeSignal.addEventListener("abort", endAll, { once: true });
	return watched;
}

/**
 * Append child records to the owning session in launch order. When the owner's workflow stage generation closes for
 * good, its children end with it (see {@link watchWorkflowStageSubagentChildren}).
 */
export function createSubagentChildRecordSink(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ctx: Pick<ExtensionContext, "sessionManager" | "orchestrationContext">,
): SubagentChildRecordSink {
	const owner = subagentChildOwner(ctx);
	const stage = watchWorkflowStageSubagentChildren(pi, ctx);
	let appended: Promise<void> = Promise.resolve();
	return {
		record(input) {
			const record: SubagentChildRecord = {
				version: 1,
				childId: subagentChildId(input.runId, input.index),
				owner,
				...input,
			};
			appended = appendInOrder(pi, record);
			stage?.childIds.add(record.childId);
			// A child that settles after its stage already closed for good ends with it at once.
			if (stage?.closeSignal.aborted) stage.end(record.childId);
		},
		ownerEndedForGood: () => stage?.endedForGood() === true,
		flushed: () => appended,
	};
}

/** `terminalStatus` of a child stopped by `pause` or `quit`; both stay resumable. */
export type SubagentChildStopStatus = "paused" | "quit";

const stopRequests = new Map<string, SubagentChildStopStatus>();

/** Mark the task about to be cancelled so its settlement is recorded as paused or quit, not interrupted. */
export function requestSubagentChildStop(taskId: string, status: SubagentChildStopStatus): void {
	stopRequests.set(taskId, status);
}

export function takeSubagentChildStop(taskId: string): SubagentChildStopStatus | undefined {
	const status = stopRequests.get(taskId);
	stopRequests.delete(taskId);
	return status;
}

/** Append a new latest observation of a child that changes only its terminal status. */
export async function recordSubagentChildStatus(
	pi: Pick<ExtensionAPI, "appendEntry">,
	record: SubagentChildRecord,
	terminalStatus: string,
): Promise<void> {
	const next: SubagentChildRecord = { ...record, state: "terminal", terminalStatus };
	observeSubagentChildRecord(next);
	await pi.appendEntry(SUBAGENT_CHILD_RECORD_TYPE, next);
}

/**
 * Append the terminal observation of a child that could not be restored and has been reported
 * gone to its owner, so no later resume retries it or repeats the report (#3760). Append-only,
 * like every other record: the child keeps its identity and only its latest state changes.
 */
export async function recordSubagentChildGone(
	pi: Pick<ExtensionAPI, "appendEntry">,
	record: SubagentChildRecord,
): Promise<void> {
	const gone: SubagentChildRecord = { ...record, state: "terminal", terminalStatus: SUBAGENT_CHILD_GONE_STATUS };
	observeSubagentChildRecord(gone);
	await pi.appendEntry(SUBAGENT_CHILD_RECORD_TYPE, gone);
}

/**
 * Fold a session's child records into the latest observation per child, in first-launch order.
 * With `ownerSessionId`, only children that session launched are read: `/fork`, `atomic --fork` and
 * branched sessions copy the original's records, but those children belong to the original session.
 */
export function readSubagentChildRecords(
	entries: readonly SessionEntry[],
	ownerSessionId?: string,
): Map<string, SubagentChildRecord> {
	const records = new Map<string, SubagentChildRecord>();
	for (const entry of entries) {
		if (!isSubagentChildRecord(entry)) continue;
		const data = entry.data as SubagentChildRecord;
		if (ownerSessionId !== undefined && data.owner?.sessionId !== ownerSessionId) continue;
		const previous = records.get(data.childId);
		records.set(data.childId, previous ? { ...previous, ...data } : data);
	}
	return records;
}

/** Resolve a child by its child id (`<runId>:<index>`), launch task id, or original intercom name. */
export function findSubagentChildRecord(
	records: ReadonlyMap<string, SubagentChildRecord>,
	id: string,
): SubagentChildRecord | undefined {
	const target = id.trim();
	const direct = records.get(target);
	if (direct) return direct;
	for (const record of records.values()) {
		if (record.taskId === target || record.intercomTarget === target) return record;
	}
	return undefined;
}

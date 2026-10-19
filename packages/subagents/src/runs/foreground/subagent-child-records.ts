import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@bastani/atomic";

/** Session entry type that durably records each background child a session launched (#3760). */
export const SUBAGENT_CHILD_RECORD_TYPE = "subagent-child";

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
 * for good. Session recovery restores only `running` children; an explicit `resume` also reopens
 * a settled child unless its `terminalStatus` is non-resumable (`killed`, `gone`).
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

/** Append child records to the owning session in launch order. */
export function createSubagentChildRecordSink(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ctx: Pick<ExtensionContext, "sessionManager" | "orchestrationContext">,
): SubagentChildRecordSink {
	const owner = subagentChildOwner(ctx);
	let chain: Promise<void> = Promise.resolve();
	return {
		record(input) {
			const record: SubagentChildRecord = {
				version: 1,
				childId: subagentChildId(input.runId, input.index),
				owner,
				...input,
			};
			chain = chain.then(() => pi.appendEntry(SUBAGENT_CHILD_RECORD_TYPE, record)).catch(() => undefined);
		},
	};
}

/** `terminalStatus` of a child that could not be restored after a restart and was reported gone to its owner. */
export const SUBAGENT_CHILD_GONE_STATUS = "gone";

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
	await pi.appendEntry(SUBAGENT_CHILD_RECORD_TYPE, { ...record, state: "terminal", terminalStatus });
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
	await pi.appendEntry(SUBAGENT_CHILD_RECORD_TYPE, gone);
}

function isSubagentChildRecord(value: SessionEntry): value is CustomEntry<SubagentChildRecord> {
	if (value.type !== "custom" || value.customType !== SUBAGENT_CHILD_RECORD_TYPE) return false;
	const data = value.data as Partial<SubagentChildRecord> | undefined;
	return (
		data?.version === 1 &&
		typeof data.childId === "string" &&
		typeof data.runId === "string" &&
		typeof data.index === "number" &&
		typeof data.agent === "string" &&
		typeof data.cwd === "string" &&
		(data.state === "running" || data.state === "terminal")
	);
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

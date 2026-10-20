import {
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	SessionManager,
	type SessionStore,
} from "@bastani/atomic";
import type { AgentSource } from "../../agents/agent-types.js";
import type { MaxOutputConfig, OutputMode, RunSyncOptions } from "../../shared/types.js";
import { type SubagentChildWorktree, unparkRunWorktree } from "./run-worktrees.js";
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
	/**
	 * Where the agent definition the launch resolved came from. The same name can be defined by more than one source,
	 * and its definition sets the child's system prompt, skills and inherited project context. Records written before
	 * Atomic recorded it have none, and restore looks the agent up in the default scope.
	 */
	readonly agentSource?: AgentSource;
	/** Whether the child was launched with `context: "fork"`, which shapes its Intercom bridge; absent means fresh. */
	readonly forked?: boolean;
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
	/** The `worktree: true` worktree the child runs in, so resume can recreate it from the run's base. */
	readonly worktree?: SubagentChildWorktree;
	readonly terminalStatus?: string;
	/**
	 * Steering and follow-up messages the child had queued but not read when pause, quit or its stage's pause stopped
	 * task `taskId`, in order. Resume delivers them once, before its own message; a later task's record supersedes them.
	 */
	readonly heldMessages?: { readonly taskId: string; readonly messages: readonly string[] };
	/** How a child admitted while it waited for a slot in its run was launched, so it can start fresh after a restart. */
	readonly launch?: SubagentChildLaunch;
}

/**
 * What a child that has not started yet needs to start as a new launch after Atomic restarts, when nothing of its
 * launch is left in the process: only what its original launch already had, and never a credential or capability.
 * The agent, cwd, worktree, run identity, Intercom identity and held messages are the record's own fields.
 */
export interface SubagentChildLaunch {
	/** The prompt the child runs, with every instruction its launch added. */
	readonly task: string;
	/** The task as the caller gave it, which its task host shows. */
	readonly intentTask?: string;
	/**
	 * The session a `context: "fork"` launch branched from its owner's conversation before admission, which the child
	 * starts on: its id, in the owner's session store, and its file when that store keeps one.
	 */
	readonly forkSession?: { readonly id: string; readonly file?: string };
	readonly sessionDir?: string;
	readonly modelOverride?: string;
	readonly skills?: readonly string[];
	readonly outputPath?: string;
	readonly outputMode?: OutputMode;
	readonly maxOutput?: MaxOutputConfig;
	readonly share?: boolean;
}

/** The launch data of a child about to wait for a slot in its run; see {@link SubagentChildLaunch}. */
export function subagentChildLaunch(
	task: string,
	intentTask: string | undefined,
	options: RunSyncOptions,
): SubagentChildLaunch {
	const forkSession = options.resumeSession ? undefined : options.sessionManager;
	const forkSessionFile = forkSession?.getSessionFile();
	return {
		task,
		...(intentTask === undefined ? {} : { intentTask }),
		...(forkSession
			? {
					forkSession: {
						id: forkSession.getSessionId(),
						...(forkSessionFile ? { file: forkSessionFile } : {}),
					},
				}
			: {}),
		...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
		...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
		...(options.skills ? { skills: options.skills } : {}),
		...(options.outputPath ? { outputPath: options.outputPath } : {}),
		...(options.outputMode ? { outputMode: options.outputMode } : {}),
		...(options.maxOutput ? { maxOutput: options.maxOutput } : {}),
		...(options.share === undefined ? {} : { share: options.share }),
	};
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

/**
 * Workflow-stage extension state this extension sets to a {@link WorkflowStageChildrenEnd}: a stage generation that
 * closed resumably and later ended for good (its blocked run was then killed or ended) ends its children through it.
 */
export const WORKFLOW_STAGE_END_CHILDREN_STATE = "atomic:workflow-stage-end-children";

export interface WorkflowStageChildrenEnd {
	/** End every settled child the stage owns, once the stage closed for good. */
	readonly endChildren: () => void;
}

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

/** Whether a workflow run ending for good ends this child: every one does that has not ended already, running or not. */
function endsWithRun(record: SubagentChildRecord): boolean {
	return record.state === "running" || endsWithStage(record);
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

/** Settles once every record of this owner handed to a sink so far has been appended. */
export function subagentChildRecordsAppended(ownerSessionId: string): Promise<void> {
	return appendChains.get(ownerSessionId) ?? Promise.resolve();
}

interface StageChildren {
	readonly closeSignal: AbortSignal;
	readonly childIds: Set<string>;
	readonly endedForGood: () => boolean;
	readonly end: (childId: string) => void;
}

const stageChildren = new WeakMap<AbortSignal, StageChildren>();
/** Workflow stage sessions with a generation in this process, whose own session records how their children end. */
const stageSessionsInProcess = new Set<string>();

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
		// It can no longer resume, so its worktree is no longer kept for it.
		unparkRunWorktree(latest.runId, latest.index);
	};
	const watched: StageChildren = { closeSignal, childIds: new Set(), endedForGood, end };
	stageChildren.set(closeSignal, watched);
	stageSessionsInProcess.add(owner.sessionId);
	const endAll = () => {
		if (!endedForGood()) return;
		const persisted = readSubagentChildRecords(sessionManager.getEntries(), owner.sessionId);
		for (const childId of new Set([...persisted.keys(), ...watched.childIds])) end(childId, persisted.get(childId));
	};
	if (closeSignal.aborted) endAll();
	else closeSignal.addEventListener("abort", endAll, { once: true });
	// A generation that closed resumably can still end for good later, after its close.
	const later: WorkflowStageChildrenEnd = { endChildren: endAll };
	admission.extensionState.set(WORKFLOW_STAGE_END_CHILDREN_STATE, later);
	return watched;
}

/**
 * Workflows → subagents: a workflow run ended for good (killed, cancelled, or failed for good). Every subagent its
 * stages launched ends with it, also when no generation of a stage is live in this process, as after a restart.
 */
export const WORKFLOW_RUN_ENDED_STAGE_SUBAGENTS_EVENT = "atomic:workflow-run-ended-stage-subagents";

export interface WorkflowRunEndedStageSubagentsRequest {
	readonly runId: string;
	/** Sessions of the run's stages; their `subagent-child` records name the children. */
	readonly stageSessionIds: readonly string[];
	/** The launching session, whose store holds the stage sessions; defaults to the one the extension last saw start. */
	readonly context?: Pick<ExtensionContext, "sessionManager">;
	completion?: Promise<void>;
}

/**
 * Record every child of the ended run's stages `stage-closed` (#3784). A stage with a generation in this process ends
 * its children through that generation's close and its own session. A stage with none, such as a dormant run's stage
 * after a restart, has the records appended to its saved session in the store, running children included, since no
 * task of theirs is left to settle. A stage session that cannot be opened is skipped.
 */
export async function endWorkflowRunStageSubagentChildren(
	ctx: Pick<ExtensionContext, "sessionManager">,
	stageSessionIds: readonly string[],
): Promise<void> {
	let store: SessionStore;
	try {
		store = ctx.sessionManager.getSessionStore();
	} catch {
		return;
	}
	for (const stageSessionId of new Set(stageSessionIds)) {
		if (stageSessionsInProcess.has(stageSessionId)) continue;
		try {
			const stageSession = await SessionManager.open(store, stageSessionId);
			for (const record of readSubagentChildRecords(stageSession.getEntries(), stageSessionId).values()) {
				if (!endsWithRun(record)) continue;
				const ended: SubagentChildRecord = {
					...record,
					state: "terminal",
					terminalStatus: SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
				};
				await stageSession.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, ended);
				observeSubagentChildRecord(ended);
			}
		} catch {
			// Its session is gone or unreadable: nothing restores its children either.
		}
	}
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
